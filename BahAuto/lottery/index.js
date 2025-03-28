import { NotFoundError, solve } from "recaptcha-solver";
import { Pool } from "@jacoblincool/puddle";
import { URLSearchParams } from "url";

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

    for (let i = 0; i < draws.length; i++) {
      pool.push(async () => {
        const idx = i;
        const { link, name } = draws[idx];

        const task_page = await context.newPage({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36',
            viewport: { width: 1366, height: 768 }
        });

        await task_page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
            Object.defineProperty(navigator, 'mimeTypes', { get: () => [1, 2, 3]});
            window.chrome = { runtime: {}, loadTimes: function() {}, csi: function() {} };
            const originalQuery = window.navigator.permissions.query;
            window.navigator.permissions.query = (parameters) => (
                parameters.name === 'notifications' ?
                    Promise.resolve({ state: 'prompt' }) :
                    originalQuery(parameters)
            );
        });

        const recaptcha = { process: false };
        task_page.on("response", async (response) => {
          if (response.url().includes("recaptcha/api2/userverify")) {
            try {
              const text = (await response.text()).replace(")]}'\n", "");
              const data = JSON.parse(text);
              recaptcha.process = data[2] === 0;
            } catch (e) { logger.warn("解析 userverify 響應失敗");}
          }
          if (response.url().includes("recaptcha/api2/reload")) {
             try {
              const text = (await response.text()).replace(")]}'\n", "");
              const data = JSON.parse(text);
              recaptcha.process = data[5] !== "nocaptcha";
             } catch (e) { logger.warn("解析 reload 響應失敗");}
          }
        });

        for (let attempts = 1; attempts <= MAX_ATTEMPTS; attempts++) {
          try {
            await task_page.goto(link, { waitUntil: 'networkidle' });
            await task_page.waitForSelector("#BH-master > .BH-lbox.fuli-pbox h1");
            await task_page.waitForTimeout(100);

            if (await task_page.$(".btn-base.c-accent-o.is-disable")) {
              logger.log(`${name} 的廣告免費次數已用完 \u001b[92m✔\u001b[m`);
              delete unfinished[name];
              break;
            }

            logger.log(`[${idx + 1} / ${draws.length}] (${attempts}) ${name} - 處理中`);

            let adSkippedOrFinished = false;
            const currentUrlParams = new URLSearchParams(task_page.url().split('?')[1]);
            const snValue = currentUrlParams.get('sn');
            if (!snValue) {
                logger.error(`[${idx + 1}] ${name} - 無法從 URL ${task_page.url()} 獲取 sn，跳過`);
                throw new Error("無法獲取 sn");
            }
            const tokenResponseRetry = await task_page.request.get("https://fuli.gamer.com.tw/ajax/getCSRFToken.php?_="+Date.now());
            const csrfTokenRetry = (await tokenResponseRetry.text()).trim();

            try {
                  const checkAdResponse = await task_page.request.get(`https://fuli.gamer.com.tw/ajax/check_ad.php?area=item&sn=${encodeURIComponent(snValue)}&_=${Date.now()}`, {
                    headers: { 'Referer': task_page.url() }
                  });
                  const checkAdData = JSON.parse(await checkAdResponse.text());
                  if (checkAdData.data && checkAdData.data.finished === 1) {
                      logger.info(`[${idx + 1}] ${name} - 廣告狀態已完成，直接嘗試兌換`);
                      adSkippedOrFinished = true;
                  } else {
                    logger.log(`[${idx + 1}] ${name} - 廣告狀態未完成，檢查是否有問題回答`);

                    let questionButton = await task_page.locator('a[onclick^="showQuestion(1);"]');
                    if (await questionButton.isVisible({timeout: 2000}).catch(() => false)) {
                        logger.log(`[${idx + 1}] ${name} - 需要回答問題`);
                        const qTokenResponse = await task_page.request.get("https://fuli.gamer.com.tw/ajax/getCSRFToken.php?_=1702883537159"); // Maybe update timestamp logic if needed
                        const qCsrfToken = (await qTokenResponse.text()).trim();
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
                         let formData = {};
                         formData['sn'] = snValue;
                         formData['token'] = qCsrfToken;
                         answers.forEach((ans, index) => {
                           formData[`answer[${index}]`] = ans;
                         });
                         try {
                           await task_page.request.post("https://fuli.gamer.com.tw/ajax/answer_question.php", { form: formData });
                           await task_page.reload({ waitUntil: 'networkidle' });
                            logger.log(`[${idx + 1}] ${name} - 問題回答完畢並重載頁面，再次檢查廣告狀態`);

                           const checkAdAfterQuestionResponse = await task_page.request.get(`https://fuli.gamer.com.tw/ajax/check_ad.php?area=item&sn=${encodeURIComponent(snValue)}&_=${Date.now()}`, {
                               headers: { 'Referer': task_page.url() }
                           });
                           const checkAdAfterQuestionData = JSON.parse(await checkAdAfterQuestionResponse.text());
                           if (checkAdAfterQuestionData.data && checkAdAfterQuestionData.data.finished === 1) {
                                logger.info(`[${idx + 1}] ${name} - 回答問題後，廣告狀態已完成`);
                                adSkippedOrFinished = true;
                           } else {
                                logger.warn(`[${idx + 1}] ${name} - 回答問題後，廣告狀態仍未完成`);
                           }
                        } catch (error) {
                             logger.error(`[${idx + 1}] ${name} - POST 回答問題時發生錯誤: ${error}`);
                             throw error;
                        }
                    } else {
                       logger.log(`[${idx + 1}] ${name} - 無需回答問題或按鈕不可見`);
                    }

                    if (!adSkippedOrFinished) {
                        logger.log(`[${idx + 1}] ${name} - 嘗試發送 finish_ad 請求`);
                         try {
                            const finishAdResponse = await task_page.request.post('https://fuli.gamer.com.tw/ajax/finish_ad.php', {
                                headers: {
                                    "Content-Type": "application/x-www-form-urlencoded",
                                    "Referer": task_page.url(),
                                    "Origin": "https://fuli.gamer.com.tw",
                                    "X-Requested-With": "XMLHttpRequest"
                                },
                                data: `token=${encodeURIComponent(csrfTokenRetry)}&area=item&sn=${encodeURIComponent(snValue)}`
                            });
                            if (finishAdResponse.ok()) {
                                logger.log(`[${idx + 1}] ${name} - finish_ad 請求成功`);
                                adSkippedOrFinished = true;
                            } else {
                                logger.error(`[${idx + 1}] ${name} - finish_ad 請求失敗，狀態碼: ${finishAdResponse.status()}`);
                                throw new Error("finish_ad 請求失敗");
                            }
                        } catch (error) {
                            logger.error(`[${idx + 1}] ${name} - 發送 finish_ad 請求時發生錯誤: ${error}`);
                             throw error;
                        }
                    }
                  }
            } catch (e) {
                logger.error(`[${idx + 1}] ${name} - 檢查或處理廣告狀態時出錯: ${e}`);
                throw e;
            }

             if (adSkippedOrFinished) {
                 logger.log(`[${idx + 1}] ${name} - 廣告已處理/跳過，準備點擊 '看廣告免費兌換'`);
                 const exchangeButton = task_page.locator('a:text("看廣告免費兌換"), a.btn-base.c-accent');

                 if (await exchangeButton.isVisible({ timeout: 5000 })) {
                    try {
                        await Promise.all([
                            task_page.waitForURL(url => url.includes('/buyD.php') && url.includes('ad=1'), { waitUntil: 'networkidle', timeout: 20000 }),
                            exchangeButton.click()
                        ]);
                        logger.log(`[${idx + 1}] ${name} - 成功導航到結算頁面: ${task_page.url()}`);

                        logger.log(`正在確認結算頁面`);
                        await checkInfo(task_page, logger).catch((...args) => logger.error(`[${idx + 1}] ${name} - checkInfo 失敗`, ...args));
                        await confirm(task_page, logger, recaptcha).catch((...args) => logger.error(`[${idx + 1}] ${name} - confirm 失敗`, ...args));

                        await task_page.waitForLoadState('networkidle', { timeout: 10000 });
                        const successElement = await task_page.locator('div.card p:has-text("成功"), div.alert-success:has-text("成功")');

                        if (await successElement.isVisible({ timeout: 5000 }).catch(() => false)) {
                           const successText = await successElement.innerText();
                           logger.success(`[${idx + 1}] 已完成抽抽樂：${name} (${successText.trim()}) \u001b[92m✔\u001b[m`);
                            lottery++;
                            delete unfinished[name];
                            break;
                        } else {
                            logger.warn(`[${idx + 1}] ${name} - 未找到成功提示。當前 URL: ${task_page.url()}`);
                            const errorElement = await task_page.locator('div.alert-danger, .ts-alert-error');
                            if (await errorElement.isVisible({ timeout: 1000 }).catch(() => false)) {
                                logger.error(`[${idx + 1}] ${name} - 發現錯誤訊息: ${await errorElement.innerText()} \u001b[91m✘\u001b[m`);
                            } else {
                                logger.error(`[${idx + 1}] ${name} - 發生未知錯誤或流程卡住，重試中 \u001b[91m✘\u001b[m`);
                            }
                        }

                    } catch (navError) {
                        logger.error(`[${idx + 1}] ${name} - 點擊兌換按鈕後等待導航至 /buyD.php 超時或失敗: ${navError.message}`);
                        logger.warn(`[${idx + 1}] ${name} - 當前 URL: ${task_page.url()}`);
                    }
                 } else {
                    logger.warn(`[${idx + 1}] ${name} - 未找到 '看廣告免費兌換' 按鈕或按鈕不可見，可能已兌換或商品問題。`);
                    if (await task_page.locator(':text("您已兌換過此商品"), :text("此獎品今日已到達兌換上限")').isVisible({ timeout: 1000 })) {
                         logger.log(`[${idx + 1}] ${name} - 商品已兌換或達上限。 \u001b[92m✔\u001b[m`);
                         delete unfinished[name];
                         break;
                     }
                 }
             } else {
                logger.error(`[${idx + 1}] ${name} - 廣告處理步驟未能完成，無法進行兌換，重試中。`);
             }

            logger.warn(`[${idx + 1} / ${draws.length}] (${attempts}) ${name} - 本次嘗試未成功，準備重試或放棄`);

          } catch (err) {
            logger.error(`[${idx + 1} / ${draws.length}] (${attempts}) ${name} - 嘗試過程中發生錯誤: ${err.message}`);
            try {
                const errorScreenshotPath = `error_${name.replace(/[\/\\?%*:|"<>]/g, '-')}_attempt_${attempts}.png`;
                await task_page.screenshot({ path: errorScreenshotPath, fullPage: true });
                logger.error(`已截圖: ${errorScreenshotPath}`);
            } catch (screenshotError) {
                logger.error(`截圖失敗: ${screenshotError}`);
            }
          }
        }

        if (unfinished[name]) {
           logger.error(`[${idx + 1}] ${name} - 達到最大重試次數 (${MAX_ATTEMPTS}) 仍未成功 \u001b[91m✘\u001b[m`);
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

async function getList(page, logger) {
  let draws = [];
  await page.context().addCookies([{ name: "ckFuli_18UP", value: "1", domain: "fuli.gamer.com.tw", path: "/" }]);
  let attempts = 3;
  while (attempts-- > 0) {
    draws = [];
    try {
      await page.goto("https://fuli.gamer.com.tw/shop.php?page=1", { waitUntil: 'networkidle' });
      let currentPage = 1;
      while (true) {
          logger.log(`正在掃描福利社頁面: ${currentPage}`);
          const itemsOnPage = await page.$$("a.items-card");
          for (const item of itemsOnPage) {
             const innerHTML = await item.innerHTML();
             if (innerHTML.includes("抽抽樂")) {
                 draws.push({
                     name: await item.$eval(".items-title", node => node.innerText.trim()),
                     link: await item.evaluate(elm => elm.href),
                 });
             }
          }

          const nextPageButton = await page.$('div.pagination a.next');
          if (!nextPageButton) {
             logger.log('沒有下一頁按鈕，掃描完畢。');
             break;
          }

          const isDisabled = await nextPageButton.evaluate(el => el.classList.contains('disable'));
          if (isDisabled) {
             logger.log('下一頁按鈕已禁用，掃描完畢。');
             break;
          }

          await Promise.all([
              page.waitForNavigation({ waitUntil: 'networkidle' }),
              nextPageButton.click()
          ]);
          currentPage++;
          await page.waitForTimeout(500); // 避免過快請求下一頁
      }
      break;
    } catch (err) {
      logger.error(`獲取抽獎列表失敗 (嘗試 ${3-attempts}/3):`, err);
      if (attempts === 0) {
          logger.error("多次嘗試獲取列表失敗，返回空列表。");
          return [];
      }
      await page.waitForTimeout(3000);
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
    if (!name) logger.warn("警告：無收件人姓名");
    if (!tel) logger.warn("警告：無收件人電話");
    if (!city || city === "0") logger.warn("警告：無收件人城市");
    if (!country || country === "0") logger.warn("警告：無收件人區域");
    if (!address) logger.warn("警告：無收件人地址");

    if (!name || !tel || !city || city === "0" || !country || country === "0" || !address)
      throw new Error("收件人資料不全，請至巴哈姆特網頁版會員中心補齊");
  } catch (err) {
    logger.error(`檢查收件人資料時發生錯誤: ${err.message}`);

  }
}

async function confirm(page, logger, recaptcha) {
  try {
    await page.waitForSelector("input[name='agreeConfirm']", { state: "attached", timeout: 10000 });
    if (await (await page.$("input[name='agreeConfirm']")).getAttribute("checked") === null) {
      await page.click("label[for='agreeConfirm']");
    }
    await page.waitForTimeout(100);

    await page.waitForSelector("a:has-text('確認兌換')", { timeout: 5000 });
    await page.click("a:has-text('確認兌換')");

    const confirmDialogButton = page.locator("div.popup-buttons button:has-text('確定')");
    await confirmDialogButton.waitFor({ state: 'visible', timeout: 10000 });

    const recaptchaIframe = page.frameLocator('iframe[src*="google.com/recaptcha/api2/anchor"]').locator('#recaptcha-anchor');
    let needRecaptcha = false;
    try {
        await recaptchaIframe.waitFor({ state: 'visible', timeout: 5000 });
        logger.log("檢測到 reCAPTCHA");
        needRecaptcha = true;
    } catch (e) {
        logger.log("未檢測到 reCAPTCHA 或超時");
        needRecaptcha = false;
    }

    const navigationPromise = page.waitForNavigation({ waitUntil: 'networkidle', timeout: 15000 }).catch(() => {
        logger.log("點擊確定後未觸發標準導航或導航超時");
    });

    await confirmDialogButton.click();

    if (needRecaptcha) {
        logger.log("正在處理 reCAPTCHA...");
        try {
          await timeout_promise(solve(page, { delay: 64 }), 60000);
          logger.log("reCAPTCHA 嘗試自動處理完成");
          await page.waitForLoadState('networkidle', { timeout: 15000 });
        } catch (err) {
            logger.error(`reCAPTCHA 處理失敗: ${err}`);
            await navigationPromise;
            throw new Error("reCAPTCHA 處理失敗");
        }
    } else {
        logger.log("無需處理 reCAPTCHA，等待最終結果");
        await navigationPromise;
    }

  } catch (err) {
    logger.error(`Confirm 函數執行錯誤，URL: ${page.url()}`);
    logger.error(err);
    throw err;
  }
}


function report({ lottery, unfinished }) {
  let body = "# 福利社抽抽樂 \n\n";
  if (lottery > 0) {
    body += `✨✨✨ 本次成功兌換 **${lottery}** 個抽獎機會 ✨✨✨\n`;
  } else {
    body += `本次未能兌換任何新的抽獎機會。\n`;
  }

  const unfinishedCount = Object.keys(unfinished).length;
  if (unfinishedCount === 0) {
    body += "✅ 所有找到的抽獎似乎都已完成或處理完畢。\n";
  } else {
    body += `⚠️ 有 **${unfinishedCount}** 個抽獎未能成功兌換：\n`;
    Object.keys(unfinished).forEach((key) => {
        if (unfinished[key] !== undefined) {
           body += `   - ❌ [${key}](${unfinished[key]})\n`;
        }
    });
    body += "請檢查日誌以獲取詳細錯誤信息。\n";
  }
  body += "\n";
  return body;
}

function timeout_promise(promise, delay) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Promise timed out after ${delay} ms`)), delay);
    promise.then(
      (res) => {
        clearTimeout(timer);
        resolve(res);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

export {
  lottery_default as default
};