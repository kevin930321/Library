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
              logger.log(`${name} 的廣告免費次數已用完 \u001B[92m✔\u001B[m`);
              delete unfinished[name];
              break;
            }
            logger.log(`[${idx + 1} / ${draws.length}] (${attempts}) ${name}`);
            for (let retried = 1; retried <= CHANGING_RETRY; retried++) {
              await Promise.all([
                task_page.waitForResponse(/ajax\/check_ad.php/, { timeout: 5e3 }).catch(() => {
                }),
                task_page.click("text=看廣告免費兌換").catch(() => {
                }),
                task_page.waitForSelector(".fuli-ad__qrcode", {
                  timeout: 5e3
                }).catch(() => {
                })
              ]);

              // 呼叫 clickAdButton 函式
              await clickAdButton(task_page, logger);

              const chargingText = await task_page.$eval(
                ".dialogify .dialogify__body p",
                (elm) => elm.innerText
              ).catch(() => {
              }) || "";
              if (chargingText.includes("廣告能量補充中")) {
                logger.info(`廣告能量補充中，重試 (${retried}/${CHANGING_RETRY})`);
                await task_page.click("button:has-text('關閉')");
                continue;
              }
              break;
            }
            if (await task_page.$eval(
              ".dialogify",
              (elm) => elm.textContent.includes("勇者問答考驗")
            ).catch(() => {
            })) {
              logger.info(`需要回答問題，正在回答問題`);
              await task_page.$$eval(
                "#dialogify_1 .dialogify__body a",
                (options) => {
                  options.forEach(
                    (option) => {
                      if (option.dataset.option == option.dataset.answer)
                        option.click();
                    }
                  );
                }
              );
              await task_page.waitForSelector("#btn-buy");
              await task_page.waitForTimeout(100);
              await task_page.click("#btn-buy");
            }
            await Promise.all([
              task_page.waitForSelector(".dialogify .dialogify__body p", { timeout: 5e3 }).catch(() => {
              }),
              task_page.waitForSelector("button:has-text('確定')", { timeout: 5e3 }).catch(() => {
              })
            ]);
            const ad_status = await task_page.$eval(
              ".dialogify .dialogify__body p",
              (elm) => elm.innerText
            ).catch(() => {
            }) || "";
            let ad_frame;
            if (ad_status.includes("廣告能量補充中")) {
              logger.error("廣告能量補充中");
              await task_page.reload().catch((...args) => logger.error(...args));
              continue;
            } else if (ad_status.includes("觀看廣告")) {
              logger.log(`正在觀看廣告`);
              await task_page.click('button:has-text("確定")');
              await task_page.waitForSelector("ins iframe").catch((...args) => logger.error(...args));
              await task_page.waitForTimeout(1e3);
              const ad_iframe = await task_page.$("ins iframe").catch(
                (...args) => logger.error(...args)
              );
              try {
                ad_frame = await ad_iframe.contentFrame();
                await shared.ad_handler({ ad_frame });
              } catch (err) {
                logger.error(err);
              }
              await task_page.waitForTimeout(1e3);
            } else if (ad_status) {
              logger.log(ad_status);
            }
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
                logger.success(`已完成一次抽抽樂：${name} \u001B[92m✔\u001B[m`);
                lottery++;
              } else {
                logger.error("發生錯誤，重試中 \u001B[91m✘\u001B[m");
              }
            } else {
              logger.warn(final_url);
              logger.error("未進入結算頁面，重試中 \u001B[91m✘\u001B[m");
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

// ... (其他函式: getList, checkInfo, confirm, report, timeout_promise)

// clickAdButton 函式
async function clickAdButton(task_page, logger) {
    // 在這裡執行跳過廣告的邏輯

    logger.log('正在嘗試跳過廣告...');

    // 獲取 CSRF token
    getCsrfToken().then(token => {
        // 發送已看廣告請求
        sendPostRequest(token, task_page); // 將 task_page 作為參數傳遞

        // 直接進入結算頁面 (模擬點擊兌換按鈕)
        setTimeout(() => {
            const adButton = task_page.querySelector('a[onclick^="window.FuliAd.checkAd"]'); // 使用 task_page 查找按鈕
            if (adButton) {
                adButton.click();
            }
        }, 2000); 
    }).catch(error => {
        console.error('獲取 CSRF token 時發生錯誤:', error);
    });
}

// 修改 getCsrfToken 和 sendPostRequest 函式，使其能夠在 clickAdButton 中被正確使用
async function getCsrfToken() {
    // ... (獲取 CSRF token 的邏輯)
}

async function sendPostRequest(csrfToken, task_page) { 
    // ... (發送已看廣告請求的邏輯，使用 task_page 執行操作)
}

export {
  lottery_default as default
};