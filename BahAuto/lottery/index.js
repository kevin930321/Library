import { NotFoundError, solve } from "recaptcha-solver";
import { Pool } from "@jacoblincool/puddle";

var lottery_default = {
    name: "福利社",
    description: "福利社抽獎",
    async run({ page, shared, params, logger }) {
        if (!shared.flags.logged)
            throw new Error("使用者未登入，無法抽獎");
        if (!shared.ad_handler)
            throw new Error("需使用 ad_handler 模組");
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
        const PARRALEL = +params.max_parallel || 1;
        const MAX_ATTEMPTS = +params.max_attempts || +shared.max_attempts || 20;
        const CHANGING_RETRY = +params.changing_retry || +shared.changing_retry || 3;
        const context = page.context();
        const pool = new Pool(PARRALEL);
        for (let i = 0; i < draws.length; i++) {
            pool.push(async () => {
                const idx = i;
                const { link, name } = draws[idx];
                const task_page = await context.newPage();
                const recaptcha = { process: false };
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
                        await task_page.waitForTimeout(100);
                        if (await task_page.$(".btn-base.c-accent-o.is-disable")) {
                            logger.log(`${name} 的廣告免費次數已用完 \u001b[92m✔\u001b[m`);
                            delete unfinished[name];
                            break;
                        }
                        logger.log(`[${idx + 1} / ${draws.length}] (${attempts}) ${name}`);

                        // 跳過廣告邏輯
                        await executeAdSkippingProcess(task_page, logger);

                        const final_url = task_page.url();
                        if (final_url.includes("/buyD.php") && final_url.includes("ad=1")) {
                            logger.log(`正在確認結算頁面`);
                            await checkInfo(task_page, logger).catch(
                                (...args) => logger.error(...args)
                            );
                            await confirm(task_page, logger, recaptcha).catch(
                                (...args) => logger.error(...args)
                            );
                            if (await task_page.$(".card > .section > p") && await task_page.$eval(
                                ".card > .section > p",
                                (elm) => elm.innerText.includes("成功")
                            )) {
                                logger.success(`已完成一次抽抽樂：${name} \u001b[92m✔\u001b[m`);
                                lottery++;
                            } else {
                                logger.error("發生錯誤，重試中 \u001b[91m✘\u001b[m");
                            }
                        } else {
                            logger.warn(final_url);
                            logger.error("未進入結算頁面，重試中 \u001b[91m✘\u001b[m");
                        }
                    } catch (err) {
                        logger.error("!", err);
                    }
                }
                await task_page.close();
            });
        }
        await pool.go();
        await page.waitForTimeout(2e3);
        logger.log(`執行完畢 ✨`);
        if (shared.report) {
            shared.report.reports["福利社抽獎"] = report({ lottery, unfinished });
        }
        return { lottery, unfinished };
    }
};

// 跳過廣告邏輯
async function executeAdSkippingProcess(page, logger) {
    await watchAdCheck(page, logger);
    const csrfToken = await getCsrfToken(page, logger);

    setTimeout(async () => {
        await sendPostRequest(page, csrfToken, logger);
    }, 2000);
}

// 獲取 CSRF token
async function getCsrfToken(page, logger) {
    try {
        const response = await page.request.get("https://fuli.gamer.com.tw/ajax/getCSRFToken.php?_=1702883537159");
        const token = await response.text();
        return token.trim();
    } catch (error) {
        logger.error('獲取 CSRF token 時發生錯誤:', error);
        throw error;
    }
}

// 發送已看完廣告的 POST 請求
async function sendPostRequest(page, csrfToken, logger) {
    const urlParams = new URLSearchParams(page.url());
    const snValue = urlParams.get('sn');

    if (!snValue) {
        logger.log('無法獲取 sn 參數');
        return;
    }

    try {
        await page.request.post("https://fuli.gamer.com.tw/ajax/finish_ad.php", {
            headers: {
                "Content-Type": "application/x-www-form-urlencoded"
            },
            data: `token=${encodeURIComponent(csrfToken)}&area=item&sn=${encodeURIComponent(snValue)}`
        });
        await page.click('text=看廣告免費兌換');
    } catch (error) {
        logger.error('發送 POST 請求時發生錯誤:', error);
        throw error;
    }
}

// 發送 GET 檢查是否已經看過廣告
async function watchAdCheck(page, logger) {
    const urlParams = new URLSearchParams(page.url());
    const snValue = urlParams.get('sn');

    if (!snValue) {
        logger.log('無法獲取 sn 參數');
        return;
    }

    try {
        const response = await page.request.get(`https://fuli.gamer.com.tw/ajax/check_ad.php?area=item&sn=${encodeURIComponent(snValue)}`);
        const responseData = JSON.parse(await response.text());

        if (responseData.data && responseData.data.finished === 1) {
            logger.log('你已經看過/跳過廣告了!');
            await page.click('text=看廣告免費兌換');
            return;
        } else {
            await page.click('text=看廣告免費兌換');
            await page.click('button:has-text("關閉")'); 
        }
    } catch (error) {
        logger.error('檢查廣告狀態時發生錯誤:', error);
        throw error;
    }
}

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
                let is_draw = await items[i].evaluate(
                    (elm) => elm.innerHTML.includes("抽抽樂")
                );
                if (is_draw) {
                    draws.push({
                        name: await items[i].evaluate(
                            (node) => node.querySelector(".items-title").innerHTML
                        ),
                        link: await items[i].evaluate((elm) => elm.href)
                    });
                }
            }
            while (await page.$eval(
                "a.pagenow",
                (elm) => elm.nextSibling ? true : false
            )) {
                await page.goto(
                    "https://fuli.gamer.com.tw/shop.php?page=" + await page.$eval(
                        "a.pagenow",
                        (elm) => elm.nextSibling.innerText
                    )
                );
                let items2 = await page.$$("a.items-card");
                for (let i = items2.length - 1; i >= 0; i--) {
                    let is_draw = await items2[i].evaluate(
                        (node) => node.innerHTML.includes("抽抽樂")
                    );
                    if (is_draw) {
                        draws.push({
                            name: await items2[i].evaluate(
                                (node) => node.querySelector(".items-title").innerHTML
                            ),
                        link: await items[i].evaluate((elm) => elm.href)
                        });
                    }
                }
            }
            break; // 成功獲取抽獎列表，跳出循環
        } catch (err) {
            logger.error("獲取抽獎列表時發生錯誤:", err);
            await page.waitForTimeout(2000); // 等待 2 秒後重試
        }
    }
    return draws;
}

// 檢查抽獎資訊
async function checkInfo(page, logger) {
    const itemName = await page.$eval(".card-title", (elm) => elm.textContent.trim());
    const itemDesc = await page.$eval(".card-description", (elm) => elm.textContent.trim());
    logger.log(`抽獎名稱: ${itemName}`);
    logger.log(`抽獎描述: ${itemDesc}`);
}

// 確認抽獎
async function confirm(page, logger, recaptcha) {
    if (recaptcha.process) {
        const solver = new solve(); // 初始化解 CAPTCHA 物件
        try {
            await page.waitForTimeout(2000); // 等待 2 秒以確保 CAPTCHA 加載
            const token = await solver.solve(page.url());
            await page.fill("#g-recaptcha-response", token);
            await page.click("button[type='submit']");
            logger.success("已成功提交抽獎!");
        } catch (error) {
            logger.error("解 CAPTCHA 時發生錯誤:", error);
        }
    } else {
        await page.click("button[type='submit']");
        logger.success("已成功提交抽獎!");
    }
}

function report({ lottery, unfinished }) {
    return {
        lottery,
        unfinished: Object.keys(unfinished),
    };
}

export default lottery_default;