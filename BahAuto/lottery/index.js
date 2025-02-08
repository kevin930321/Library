import { NotFoundError, solve } from "recaptcha-solver";
import { Pool } from "@jacoblincool/puddle";

var lottery_default = {
    name: "福利社",
    description: "福利社抽獎",
    async run({ page, shared, params, logger }) {
        if (!shared.flags.logged) throw new Error("使用者未登入，無法抽獎");
        if (!shared.ad_handler) throw new Error("需使用 ad_handler 模組");

        logger.log(`開始執行`);
        let lottery = 0;
        logger.log("正在尋找抽抽樂");
        const draws = await getList(page, logger);
        logger.log(`找到 ${draws.length} 個抽抽樂`);

        const unfinished = {};
        draws.forEach(({ name, link }, i) => {
            logger.log(`${i + 1}: ${name}`);
            unfinished[name] = link;
        });

        const PARRALLEL = +params.max_parallel || 1;
        const MAX_ATTEMPTS = +params.max_attempts || +shared.max_attempts || 20;
        const CHANGING_RETRY = +params.changing_retry || +shared.changing_retry || 3;
        const context = page.context();
        const pool = new Pool(PARRALLEL);

        // 設定 User-Agent (範例，可根據需要更改)
        await context.setExtraHTTPHeaders({
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        });

        for (let i = 0; i < draws.length; i++) {
            pool.push(async () => {
                const idx = i;
                const { link, name } = draws[idx];
                const task_page = await context.newPage();
                const recaptcha = { process: false };

                // reCAPTCHA 監聽
                task_page.on("response", async (response) => {
                    if (response.url().includes("recaptcha/api2/userverify")) {
                        const text = (await response.text()).replace(")]}'\n", "");
                        const data = JSON.parse(text);
                        recaptcha.process = data[2] === 0;
                    }
                    if (response.url().includes("recaptcha/api2/reload")) {
                        const text = (await response.text()).replace(")]}'\n", "");
                        const data = JSON.parse(text);
                        recaptcha.process = data[5] !== "nocaptcha";
                    }
                });

                for (let attempts = 1; attempts <= MAX_ATTEMPTS; attempts++) {
                    try {
                        await task_page.goto(link);
                        await task_page.waitForSelector("#BH-master > .BH-lbox.fuli-pbox h1");

                        if (await task_page.$(".btn-base.c-accent-o.is-disable")) {
                            logger.log(`${name} 的廣告免費次數已用完 ✔`);
                            delete unfinished[name];
                            break;
                        }
                        logger.log(`[${idx + 1} / ${draws.length}] (${attempts}) ${name}`);

                        // 取得 CSRF token (移到迴圈外部)
                        const tokenResponse = await task_page.request.get("https://fuli.gamer.com.tw/ajax/getCSRFToken.php?_=1702883537159");
                        const csrfToken = (await tokenResponse.text()).trim();

                        for (let retried = 1; retried <= CHANGING_RETRY; retried++) {
                           // 檢查廣告按鈕
                            let adButtonLocator = task_page.locator('a[onclick^="window.FuliAd.checkAd"]');
                            if (!(await adButtonLocator.isVisible())) {
                                logger.warn('沒有發現廣告兌換按鈕, 可能為商品次數用盡或是已過期。');
                                break;
                            }

                            // 檢查是否需要回答問題
                            let questionButton = await task_page.locator('a[onclick^="showQuestion(1);"]');
                            if (await questionButton.isVisible()) {
                                logger.log("需要回答問題，正在回答問題");

                                // 取得問題和答案
                                const templateContent = await task_page.locator("#question-popup").innerHTML();
                                let questionNumbers = [];
                                let regex = /data-question="(\d+)"/g;
                                let match;

                                while ((match = regex.exec(templateContent)) !== null) {
                                    questionNumbers.push(match[1]);
                                }

                                let answers = [];
                                for (let question of questionNumbers) {
                                    const answer = await task_page.locator(`.fuli-option[data-question="${question}"]`).getAttribute("data-answer");
                                    answers.push(answer);
                                }

                                // 準備表單資料
                                let formData = {};
                                const urlParams = new URLSearchParams(task_page.url().split('?')[1]);
                                let snValue = urlParams.get('sn');
                                formData['sn'] = snValue;
                                formData['token'] = csrfToken;
                                answers.forEach((ans, index) => {
                                    formData[`answer[${index}]`] = ans;
                                });

                                // 送出答案
                                try {
                                    await task_page.request.post("https://fuli.gamer.com.tw/ajax/answer_question.php", { form: formData });
                                    await task_page.reload();
                                    await task_page.waitForLoadState('networkidle');
                                } catch (error) {
                                    logger.error("post 回答問題時發生錯誤,正在重試中");
                                    break; // 停止此次重試
                                }
                            }
                             // 檢查廣告狀態
                            const urlParams = new URLSearchParams(task_page.url().split('?')[1]);
                            const snValue = urlParams.get('sn');
                            try {
                                const response = await task_page.request.get("https://fuli.gamer.com.tw/ajax/check_ad.php?area=item&sn=" + encodeURIComponent(snValue));
                                const data = JSON.parse(await response.text());

                                if (data.data && data.data.finished === 1) {
                                    logger.info("廣告已跳過");
                                    break; // 廣告已跳過，跳出重試迴圈
                                }
                            } catch (e) {
                                logger.error('解析廣告狀態檢查的請求發生錯誤, 正在重試中:', e);
                                break; // 停止此次重試
                            }

                            // 完成廣告 (發送 POST 請求)
                            try {
                                await task_page.request.post('https://fuli.gamer.com.tw/ajax/finish_ad.php', {
                                    headers: {
                                        "Content-Type": "application/x-www-form-urlencoded"
                                    },
                                    data: "token=" + encodeURIComponent(csrfToken) + "&area=item&sn=" + encodeURIComponent(snValue)
                                });
                            } catch (error) {
                                logger.error("發送已看廣告請求時發生錯誤:", error);
                                break; // 停止此次重試
                            }
                            break;
                        }

                        // 點擊「看廣告免費兌換」按鈕 (使用更穩定的選擇器)
                        await task_page.locator('text=看廣告免費兌換').click({ timeout: 5000 }).catch(() => {});

                        // 等待進入結算頁面 (使用 waitForURL)
                        await task_page.waitForURL(/buyD\.php\?.*ad=1/, { timeout: 10000 }).catch(() => {});

                        const final_url = task_page.url();
                        if (final_url.includes("/buyD.php") && final_url.includes("ad=1")) {
                            // 確認結算頁面
                            logger.log(`正在確認結算頁面`);
                            await checkInfo(task_page, logger).catch((...args) => logger.error(...args));
                            await confirm(task_page, logger, recaptcha).catch((...args) => logger.error(...args));

                            // 檢查是否成功
                            if (await task_page.$(".card > .section > p") && await task_page.$eval(".card > .section > p", (elm) => elm.innerText.includes("成功"))) {
                                logger.success(`已完成一次抽抽樂：${name} ✔`);
                                lottery++;
                            } else {
                                logger.warn(final_url);
                                logger.error("發生錯誤，重試中 ✘");
                            }
                        } else {
                            logger.warn(final_url);
                            logger.error("未進入結算頁面，重試中 ✘");
                        }
                    } catch (err) {
                        logger.error("!", err);
                        // 加入指數退避 (這裡的延遲時間會越來越長)
                        await task_page.waitForTimeout(1000 * 2 ** attempts);
                    }
                }

                await task_page.close();
            });
        }

        await pool.go();
        await page.waitForTimeout(2000); // 等待所有任務完成
        logger.log(`執行完畢 ✨`);

        if (shared.report) {
            shared.report.reports["福利社抽獎"] = report({ lottery, unfinished });
        }

        return { lottery, unfinished };
    }
};

async function getList(page, logger) {
    let draws;
    await page.context().addCookies([{ name: "ckFuli_18UP", value: "1", domain: "fuli.gamer.com.tw", path: "/" }]);
    let attempts = 3;
    while (attempts-- > 0) {
        draws = [];
        try {
            await page.goto("https://fuli.gamer.com.tw/shop.php?page=1");
            let items = await page.$$("a.items-card");
            for (let i = items.length - 1; i >= 0; i--) {
                let is_draw = await items[i].evaluate((elm) => elm.innerHTML.includes("抽抽樂"));
                if (is_draw) {
                    draws.push({
                        name: await items[i].evaluate((node) => node.querySelector(".items-title").innerHTML),
                        link: await items[i].evaluate((elm) => elm.href),
                    });
                }
            }

            // 翻頁
            while (await page.$eval("a.pagenow", (elm) => elm.nextSibling ? true : false)) {
                await page.goto("https://fuli.gamer.com.tw/shop.php?page=" + await page.$eval("a.pagenow", (elm) => elm.nextSibling.innerText));
                let items2 = await page.$$("a.items-card");
                for (let i = items2.length - 1; i >= 0; i--) {
                    let is_draw = await items2[i].evaluate((node) => node.innerHTML.includes("抽抽樂"));
                    if (is_draw) {
                        draws.push({
                            name: await items2[i].evaluate((node) => node.querySelector(".items-title").innerHTML),
                            link: await items2[i].evaluate((elm) => elm.href),
                        });
                    }
                }
            }
            break; // 成功取得列表，跳出迴圈
        } catch (err) {
            logger.error(err);
            // 加入隨機延遲
            await page.waitForTimeout(Math.random() * 2000 + 1000); // 1-3 秒
        }
    }
    return draws;
}

async function checkInfo(page, logger) {
    try {
        const name = await page.$eval("#name", (elm) => elm.value);
        const tel = await page.$eval("#tel", (elm) => elm.value);
        const city = await page.$eval("[name=city]", (elm) => elm.value);
        const country = await page.$eval("[name=country]", (elm) => elm.value);
        const address = await page.$eval("#address", (elm) => elm.value);

        if (!name) logger.log("無收件人姓名");
        if (!tel) logger.log("無收件人電話");
        if (!city) logger.log("無收件人城市");
        if (!country) logger.log("無收件人區域");
        if (!address) logger.log("無收件人地址");

        if (!name || !tel || !city || !country || !address)
            throw new Error("警告：收件人資料不全");

    } catch (err) {
        logger.error(err);
    }
}

async function confirm(page, logger, recaptcha) {
    try {
        // 勾選同意
        await page.locator("input[name='agreeConfirm']").check({ force: true });

        // 點擊「確認兌換」
        await page.locator("a:has-text('確認兌換')").click();

        // 點擊彈出視窗的「確定」
        await page.locator("button:has-text('確定')").click();
        await page.waitForTimeout(300); // 稍微等待

        // reCAPTCHA 處理 (如果需要)
        if (recaptcha.process === true) {
            const recaptcha_frame_width = await page.$eval("iframe[src^='https://www.google.com/recaptcha/api2/bframe']", (elm) => getComputedStyle(elm).width);
            if (recaptcha_frame_width !== "100%") {
                logger.log("需要處理 reCAPTCHA");
                try {
                    await timeout_promise(solve(page, { delay: 64 }), 30000); // 30 秒超時
                } catch (err) {
                    if (err instanceof NotFoundError) {
                        logger.error('reCAPTCHA [Try it later]');
                    }
                    throw err;
                }
                logger.log("reCAPTCHA 自動處理完成");
            }
        }
        await page.waitForNavigation().catch(() => { });

    } catch (err) {
        logger.error(page.url());
        logger.error(err);
    }
}

function report({ lottery, unfinished }) {
    let body = "# 福利社抽抽樂 \n\n";
    if (lottery) {
        body += `✨✨✨ 獲得 **${lottery}** 個抽獎機會，價值 **${(lottery * 500).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}** 巴幣 ✨✨✨\n`;
    }
    if (Object.keys(unfinished).length === 0) {
        body += "🟢 所有抽獎皆已完成\n";
    }
    Object.keys(unfinished).forEach((key) => {
        if (unfinished[key] === void 0) return;
        body += `❌ 未能自動完成所有 ***[${key}](${unfinished[key]})*** 的抽獎\n`;
    });
    body += "\n";
    return body;
}

function timeout_promise(promise, delay) {
    return new Promise((resolve, reject) => {
        setTimeout(() => reject("Timed Out"), delay);
        promise.then(resolve).catch(reject);
    });
}

export {
    lottery_default as default
};