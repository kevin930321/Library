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

            // --- 跳過廣告流程 ---
            logger.log(`正在跳過廣告: ${name}`); 
            await executeAdSkippingProcess(task_page, logger);
            // --- 跳過廣告流程結束 ---

            if (await task_page.$(".btn-base.c-accent-o.is-disable")) {
              logger.log(`${name} 的廣告免費次數已用完 \u001b[92m✔\u001b[m`);
              delete unfinished[name];
              break;
            }
            logger.log(`[${idx + 1} / ${draws.length}] (${attempts}) ${name}`);

            // --- 檢查是否需要回答問題，並點擊 "看廣告免費兌換" ---
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

            // 檢查是否有 "廣告能量補充中" 的提示
            const chargingText = await task_page.$eval(
              ".dialogify .dialogify__body p",
              (elm) => elm.innerText
            ).catch(() => {
            }) || "";

            if (chargingText.includes("廣告能量補充中")) {
              logger.info(`廣告能量補充中，關閉彈窗`);
              await task_page.click("button:has-text('關閉')");
            }

            // --- 檢查是否需要回答問題 ---
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
            // --- 檢查是否需要回答問題結束 ---

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
              link: await items2[i].evaluate((elm) => elm.href)
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
    if (!name)
      logger.log("無收件人姓名");
    if (!tel)
      logger.log("無收件人電話");
    if (!city)
      logger.log("無收件人城市");
    if (!country)
      logger.log("無收件人區域");
    if (!address)
      logger.log("無收件人地址");
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
    const next_navigation = page.waitForNavigation().catch(() => {
    });
    await page.waitForSelector("button:has-text('確定')");
    await page.click("button:has-text('確定')");
    await page.waitForTimeout(300);
    if (recaptcha.process === true) {
      const recaptcha_frame_width = await page.$eval(
        "iframe[src^='https://www.google.com/recaptcha/api2/bframe']",
        (elm) => getComputedStyle(elm).width
      );
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
    body += `✨✨✨ 獲得 **${lottery}** 個抽獎機會，價值 **${(lottery * 500).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}** 巴幣 ✨✨✨
`;
  }
  if (Object.keys(unfinished).length === 0) {
    body += "🟢 所有抽獎皆已完成\n";
  }
  Object.keys(unfinished).forEach((key) => {
    if (unfinished[key] === void 0)
      return;
    body += `❌ 未能自動完成所有 ***[${key}](${unfinished[key]})*** 的抽獎
`;
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

// --- 跳過廣告函式 ---
async function executeAdSkippingProcess(page, logger) {

  // 獲取當前頁面 URL 並列印
  const currentUrl = page.url();
  logger.debug(`[Debug] 兌換頁面 URL: ${currentUrl}`); 

  // 使用正則表達式提取 sn 參數
  const snMatch = currentUrl.match(/sn=(\d+)/); 
  if (snMatch) {
    const snValue = snMatch[1];
    logger.debug(`[Debug] 提取到的 sn 參數: ${snValue}`);

    // 獲取 CSRF token
    logger.debug('[Debug] 正在獲取 CSRF token...');
    const csrfToken = await getCsrfToken(page, logger); // 將 logger 作為參數傳遞給 getCsrfToken
    logger.debug(`[Debug] CSRF token: ${csrfToken}`);

    // 模擬點擊 "看廣告免費兌換" 按鈕
    logger.debug('[Debug] 正在發送 POST 請求...');
    await sendPostRequest(page, csrfToken, snValue); // 將 snValue 傳遞給 sendPostRequest 函數
    logger.debug('[Debug] POST 請求已發送');

    // 等待頁面跳轉
    logger.debug('[Debug] 等待頁面跳轉...');
    await page.waitForNavigation(); 
    logger.debug(`[Debug] 頁面已跳轉到: ${page.url()}`);
  } else {
    logger.error('[Debug] 無法從 URL 中提取 sn 參數');
  }
}

async function getCsrfToken(page, logger) { // 添加 logger 參數
  logger.debug('[Debug] 正在請求 CSRF token...');
  const response = await page.request.get("https://fuli.gamer.com.tw/ajax/getCSRFToken.php?_=1702883537159");
  logger.debug('[Debug] CSRF token 請求已發送');

  const token = await response.text();
  logger.debug(`[Debug] CSRF token 響應: ${token}`);
  return token.trim();
}

async function sendPostRequest(page, csrfToken, snValue) { 
  logger.debug('[Debug] 正在發送 POST 請求...');
  const response = await page.request.post("https://fuli.gamer.com.tw/ajax/finish_ad.php", {
    data: {
      token: csrfToken,
      area: "item",
      sn: snValue // 使用提取到的 snValue
    }
  });
  logger.debug('[Debug] POST 請求已發送');

  // 檢查響應狀態碼
  logger.debug(`[Debug] POST 請求響應狀態碼: ${response.status()}`);

  // 獲取響應內容
  const responseText = await response.text();
  logger.debug(`[Debug] POST 請求響應內容: ${responseText}`); 
}
// --- 跳過廣告函式結束 ---

export {
  lottery_default as default
};