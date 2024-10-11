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
              logger.log(`${name} 的廣告免費次數已用完 \u001b[92m✔\u001b[m`);
              delete unfinished[name];
              break;
            }
            logger.log(`[${idx + 1} / ${draws.length}] (${attempts}) ${name}`);

            // 跳過廣告邏輯 (參考程式碼 B)
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

// 跳過廣告邏輯 (參考程式碼 B)
async function executeAdSkippingProcess(page, logger) {
    const snValue = await getSnValue(page, logger); // 在適當的時機獲取 sn 參數
    
    if (!snValue) {
        logger.log('無法獲取 sn 參數');
        return;
    }
    
    await watchAdCheck(page, snValue, logger);
    const csrfToken = await getCsrfToken(page, logger);

    setTimeout(async () => {
        await sendPostRequest(page, csrfToken, snValue, logger);
    }, 2000);
}

// 獲取 sn 參數
async function getSnValue(page, logger) {
    try {
        // 等待頁面元素加载完成，确保 sn 參數可用
        await page.waitForSelector('.fuli-pbox');
        
        // 使用 page.evaluate 執行 JavaScript 程式碼獲取 sn 參數
        return await page.evaluate(() => {
            return document.querySelector('.fuli-pbox').dataset.sn; 
        });
    } catch (error) {
        logger.error('獲取 sn 參數時發生錯誤:', error);
        // 使用正則表達式作为备用方案提取 sn 參數
        return page.url().match(/sn=(\d+)/)?.[1];
    }
}

// 獲取 CSRF token (參考程式碼 B)
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

// 發送已看完廣告的 POST 請求 (參考程式碼 B)
async function sendPostRequest(page, csrfToken, snValue, logger) {
    try {
        await page.request.post("https://fuli.gamer.com.tw/ajax/finish_ad.php", {
            headers: {
                "Content-Type": "application/x-www-form-urlencoded"
            },
            data: "token=" + encodeURIComponent(csrfToken) + "&area=item&sn=" + encodeURIComponent(snValue)
        });
        // 模擬點擊 "看廣告免費兌換" 按鈕，觸發頁面更新
        await page.click('text=看廣告免費兌換');
    } catch (error) {
        logger.error('發送 POST 請求時發生錯誤:', error);
        throw error;
    }
}

// 發送 GET 檢查是否已經看過廣告 (參考程式碼 B)
async function watchAdCheck(page, snValue, logger) {
    try {
        const response = await page.request.get("https://fuli.gamer.com.tw/ajax/check_ad.php?area=item&sn=" + encodeURIComponent(snValue));
        const responseData = JSON.parse(await response.text());

        if (responseData.data && responseData.data.finished === 1) {
            logger.log('你已經看過/跳過廣告了!');
            // 模擬點擊 "看廣告免費兌換" 按鈕，觸發頁面更新
            await page.click('text=看廣告免費兌換');
            return;
        } else {
            // 模擬點擊 "看廣告免費兌換" 按鈕，觸發廣告彈窗
            await page.click('text=看廣告免費兌換');
            // 立即關閉彈窗 (模擬跳過廣告)
            await page.click('button:has-text("關閉")'); 
        }
    } catch (error) {
        logger.error('檢查廣告狀態時發生錯誤:', error);
        throw error;
    }
}

export {
  lottery_default as default
};