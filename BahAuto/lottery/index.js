import { NotFoundError, solve } from "recaptcha-solver";
import { Pool } from "@jacoblincool/puddle";
import path from 'path';
import fs from 'fs';

const traceDir = path.join(process.cwd(), 'playwright-traces');
fs.mkdirSync(traceDir, { recursive: true });

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
        const task_page = await context.newPage();
        const tracePath = path.join(traceDir, `trace_${idx + 1}_${name.replace(/[^a-zA-Z0-9]/g, '_')}.zip`);
        try {
            await task_page.context().tracing.start({
                name: `Trace for ${name} (Task ${idx + 1})`,
                screenshots: true,
                snapshots: true,
                sources: true
            });
        } catch (traceError) {
            logger.error(`[${idx + 1}] ${name} - 無法開始 tracing:`, traceError);
        }

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

        try {
            for (let attempts = 1; attempts <= MAX_ATTEMPTS; attempts++) {
                try {
                    await task_page.goto(link, { waitUntil: 'domcontentloaded' });
                    await task_page.waitForSelector("#BH-master > .BH-lbox.fuli-pbox h1", { timeout: 15000 });

                     if (await task_page.locator(".btn-base.c-accent-o.is-disable").isVisible()) {
                         logger.log(`${name} 的廣告免費次數已用完 \u001b[92m✔\u001b[m`);
                         delete unfinished[name];
                         break;
                     }
                     logger.log(`[${idx + 1} / ${draws.length}] (${attempts}) ${name}`);
                     for (let retried = 1; retried <= CHANGING_RETRY; retried++) {
                       let adButtonLocator = task_page.locator('a[onclick^="window.FuliAd.checkAd"]');
                       let questionButton = task_page.locator('a[onclick^="showQuestion(1);"]');

                       if (await questionButton.isVisible({ timeout: 500 }).catch(() => false)) {
                         logger.log("需要回答問題，正在回答問題");
                         const tokenResponse = await task_page.request.get("https://fuli.gamer.com.tw/ajax/getCSRFToken.php?_=1702883537159");
                         const csrfToken = (await tokenResponse.text()).trim();
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
                         const urlParams = new URLSearchParams(task_page.url().split('?')[1]);
                         let snValue = urlParams.get('sn');
                         formData['sn'] = snValue;
                         formData['token'] = csrfToken;
                         answers.forEach((ans, index) => {
                           formData[`answer[${index}]`] = ans;
                         });
                         try {
                           await task_page.request.post("https://fuli.gamer.com.tw/ajax/answer_question.php", {
                             form: formData
                           });
                           await task_page.reload({ waitUntil: 'networkidle' });
                         } catch (error) {
                           logger.error("post 回答問題時發生錯誤,正在重試中");
                           break;
                         }
                       }
                       if (!(await adButtonLocator.isVisible({ timeout: 10000 }))){
                          logger.warn(`${name}: 沒有發現廣告兌換按鈕，可能為商品次數用盡、已過期或頁面加載問題。`);
                          if (retried === CHANGING_RETRY) {
                            logger.error(`${name}: 多次嘗試後仍未找到廣告按鈕，放棄此項目。`);
                          }
                          await task_page.waitForTimeout(2000);
                          continue;
                       }


                       const urlParams = new URLSearchParams(task_page.url().split('?')[1]);
                       const snValue = urlParams.get('sn');
                       if (!snValue) {
                         logger.error(`${name}: 無法從 URL 獲取 sn 值`);
                         throw new Error('SN value missing from URL');
                       }
                       logger.log(`${name}: sn= ${snValue}`);

                       try {
                           const response = await task_page.request.get(`https://fuli.gamer.com.tw/ajax/check_ad.php?area=item&sn=${encodeURIComponent(snValue)}`);
                           if (!response.ok()) {
                               logger.warn(`${name}: 檢查廣告狀態請求失敗: ${response.status()}`);
                               await task_page.waitForTimeout(1000 * retried);
                               continue;
                           }
                           const responseBody = await response.text();
                            if (!responseBody) {
                               logger.warn(`${name}: 檢查廣告狀態收到空響應`);
                               await task_page.waitForTimeout(1000 * retried);
                               continue;
                             }

                           const data = JSON.parse(responseBody);
                           if (data.data && data.data.finished === 1) {
                               logger.info(`${name}: 廣告已完成 (checked)`);
                               break;
                           } else {
                               logger.info(`${name}: 廣告未完成，嘗試手動標記完成`);
                           }
                       } catch (e) {
                           logger.error(`${name}: 檢查廣告狀態時出錯 (或 JSON 解析失敗): ${e}`, e.stack);
                           await task_page.waitForTimeout(1000 * retried);
                           continue;
                       }
                       const tokenResponse = await task_page.request.get(`https://fuli.gamer.com.tw/ajax/getCSRFToken.php?_=${Date.now()}`);
                       const csrfToken = (await tokenResponse.text()).trim();
                       try {
                         const finishResponse = await task_page.request.post('https://fuli.gamer.com.tw/ajax/finish_ad.php', {
                             headers: {
                               "Content-Type": "application/x-www-form-urlencoded",
                               "Referer": task_page.url(),
                               "X-Requested-With": "XMLHttpRequest"
                             },
                             data: `token=${encodeURIComponent(csrfToken)}&area=item&sn=${encodeURIComponent(snValue)}`
                         });
                         if (!finishResponse.ok()) {
                            logger.warn(`${name}: 手動標記廣告完成請求失敗: ${finishResponse.status()}`);
                            await task_page.waitForTimeout(1000 * retried);
                            continue;
                         }
                          const finishData = await finishResponse.json().catch(e => {logger.error(`${name}: 解析 finish_ad 響應 JSON 失敗`,e); return null;});
                          if (finishData && finishData.error === 0){
                            logger.info(`${name}: 手動標記廣告完成成功`);
                          } else {
                            logger.warn(`${name}: 手動標記廣告完成似乎失敗，伺服器回覆:`, finishData);
                          }
                       } catch (error) {
                         logger.error(`${name}: 發送已看廣告請求時發生錯誤: ${error}`);
                         await task_page.waitForTimeout(1000 * retried);
                         continue;
                       }

                       break;
                     }
            logger.log(`${name}: 嘗試點擊 '看廣告免費兌換' 按鈕`);
            const exchangeButton = task_page.locator('a:has-text("看廣告免費兌換")');
            try {
               await exchangeButton.waitFor({ state: 'visible', timeout: 15000 });
            } catch(e) {
               logger.error(`${name}: '看廣告免費兌換' 按鈕在超時後仍未出現或不可見，可能廣告流程未正確完成。`);
               throw new Error("Exchange button not visible or ready.");
            }
            await exchangeButton.click();

            logger.log(`${name}: 已點擊按鈕，等待導航至結算頁面...`);
            try {
              await task_page.waitForURL(/buyD\.php\?.*ad=1/, { timeout: 20000, waitUntil: 'domcontentloaded' });
              logger.log(`${name}: 已成功導航至結算頁面: ${task_page.url()}`);
            } catch (err) {
              const currentUrl = task_page.url();
              logger.error(`${name}: 等待導航至結算頁面超時或失敗。當前 URL: ${currentUrl} \u001b[91m✘\u001b[m`);
              throw new Error("Navigation to checkout page failed or timed out.");
            }

            const final_url = task_page.url();
            if (final_url.includes("/buyD.php") && final_url.includes("ad=1")) {
                logger.log(`${name}: 正在結算頁面執行操作`);
                await checkInfo(task_page, logger).catch((...args) => logger.error(`${name}: checkInfo 錯誤`, ...args));
                await confirm(task_page, logger, recaptcha).catch((...args) => logger.error(`${name}: confirm 錯誤`, ...args));

                try {
                    const successMsg = task_page.locator('.card .section p:has-text("成功")');
                    const errorMsg = task_page.locator('.card .alert-danger');
                    await Promise.race([
                      successMsg.waitFor({ state: 'visible', timeout: 10000 }),
                      errorMsg.waitFor({ state: 'visible', timeout: 10000 })
                    ]);

                    if (await successMsg.isVisible()) {
                       logger.success(`${name}: 已完成一次抽抽樂 \u001b[92m✔\u001b[m`);
                       lottery++;
                       delete unfinished[name];
                       break;
                    } else if (await errorMsg.isVisible()) {
                        const errorText = await errorMsg.textContent();
                        logger.error(`${name}: 兌換失敗，錯誤訊息: ${errorText.trim()} \u001b[91m✘\u001b[m`);
                    } else {
                         logger.warn(`${name}: 未找到明確的成功或失敗訊息，URL: ${final_url} \u001b[91m✘\u001b[m`);
                    }

                } catch(e) {
                     logger.error(`${name}: 等待兌換結果訊息時發生錯誤或超時，URL: ${final_url} \u001b[91m✘\u001b[m`, e);
                }
            } else {
              logger.error(`${name}: 意外情況 - 點擊後未導航到預期的結算頁面。當前 URL: ${final_url} \u001b[91m✘\u001b[m`);
            }
          }
         catch (err) {
            logger.error(`[${idx + 1}] (${attempts}) ${name} 執行時發生未預期錯誤:`, err.message);
             if (attempts === MAX_ATTEMPTS) {
                 logger.error(`[${idx + 1}] ${name} 已達最大嘗試次數 ${MAX_ATTEMPTS}，放棄此項目。`);
                 if (!unfinished.hasOwnProperty(name)) { unfinished[name] = link;}
             } else {
               logger.info(`${name}: 等待 ${2*attempts} 秒後重試...`);
               await task_page.waitForTimeout(2000 * attempts);
             }
          }
        }

        } finally {
             try {
                 logger.log(`[${idx + 1}] ${name} - 停止 tracing, 保存到: ${tracePath}`);
                 await task_page.context().tracing.stop({ path: tracePath });
                 logger.log(`[${idx + 1}] ${name} - Tracing 文件已保存`);
             } catch (stopTraceError) {
                 logger.error(`[${idx + 1}] ${name} - 停止 tracing 時發生錯誤:`, stopTraceError);
             }
             await task_page.close();
        }

      });
    }
    await pool.go();
    await page.waitForTimeout(2000);
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
      break;
    } catch (err) {
      logger.error(err);
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
    await page.waitForSelector("input[name='agreeConfirm']", { state: "attached" });
    if (await (await page.$("input[name='agreeConfirm']")).getAttribute("checked") === null) {
      await page.click("text=我已閱讀注意事項，並確認兌換此商品");
    }
    await page.waitForTimeout(100);
    await page.waitForSelector("a:has-text('確認兌換')");
    await page.click("a:has-text('確認兌換')");
    const next_navigation = page.waitForNavigation().catch(() => {});
    await page.waitForSelector("button:has-text('確定')");
    await page.click("button:has-text('確定')");
    await page.waitForTimeout(300);
    if (recaptcha.process === true) {
      const recaptcha_frame_width = await page.$eval("iframe[src^='https://www.google.com/recaptcha/api2/bframe']", (elm) => getComputedStyle(elm).width);
      if (recaptcha_frame_width !== "100%") {
        logger.log("需要處理 reCAPTCHA");
        try {
          await timeout_promise(solve(page, { delay: 64 }), 3e4);
        } catch (err) {
          if (err instanceof NotFoundError) {
            logger.error("reCAPTCHA [Try it later]");
          }
          throw err;
        }
        logger.log("reCAPTCHA 自動處理完成");
      }
    }
    await next_navigation;
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