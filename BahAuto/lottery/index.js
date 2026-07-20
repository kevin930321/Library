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
          let snValue;
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
            
            for (let retried = 1; retried <= CHANGING_RETRY; retried++) {
              if (await task_page.$("#question-popup")) {
                logger.log("需要回答問題，正在回答問題");
                
                let csrfToken = await task_page.evaluate(async () => {
                    const res = await fetch("https://fuli.gamer.com.tw/ajax/getCSRFToken.php?_=" + Date.now());
                    return (await res.text()).trim();
                });
                
                const templateContent = await task_page.locator("#question-popup").innerHTML();
                const tempDiv = await task_page.evaluateHandle((content) => {
                    const div = document.createElement('div');
                    div.innerHTML = content;
                    return div;
                }, templateContent);
                const options = await tempDiv.$$('.fuli-option');
                let answers = [];
                for (const option of options) {
                    const datasetOption = await option.evaluate(node => node.dataset.option);
                    const datasetAnswer = await option.evaluate(node => node.dataset.answer);
                    if (datasetOption == datasetAnswer) {
                        answers.push(datasetAnswer);
                    }
                }
                logger.log(`提取到的答案: ${JSON.stringify(answers)}`);
                
                let formData = {};
                const matchInfo = task_page.url().match(/[?&]sn=(\d+)/);
                snValue = matchInfo ? matchInfo[1] : null;
                formData['sn'] = snValue;
                formData['token'] = csrfToken;
                answers.forEach((ans, index) => {
                  formData[`answer[${index}]`] = ans;
                });
                
                try {
                  await task_page.evaluate(async (data) => {
                      const params = new URLSearchParams();
                      for (const key in data) params.append(key, data[key]);
                      await fetch("https://fuli.gamer.com.tw/ajax/answer_question.php", {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                          body: params.toString()
                      });
                  }, formData);
                  await task_page.reload();
                  await task_page.waitForLoadState('networkidle');
                } catch (error) {
                  logger.error("post 回答問題時發生錯誤,正在重試中");
                  continue;
                }
              }
              
              const match = task_page.url().match(/[?&]sn=(\d+)/);
              snValue = match ? match[1] : null;
              
              if (!snValue) {
                 logger.error("無法取得商品 sn 代碼，重試中");
                 await task_page.waitForTimeout(1000);
                 continue;
              }
              
              logger.log('sn:', snValue);
              
              let isAdFinished = false;
              try {
                const responseText = await task_page.evaluate(async (sn) => {
                  const res = await fetch("https://fuli.gamer.com.tw/ajax/check_ad.php?area=item&sn=" + encodeURIComponent(sn));
                  return await res.text();
                }, snValue);
                
                if (responseText.trim().startsWith("<")) {
                  logger.error("check_ad.php 回傳了 HTML，可能遭到 Cloudflare 阻擋");
                } else {
                  const data = JSON.parse(responseText);
                  if (data && data.data && data.data.finished === 1) {
                    logger.info("已經跳過廣告了");
                    isAdFinished = true;
                  }
                }
              } catch (e) {
                logger.error(`解析廣告狀態檢查的請求發生錯誤: ${e.message}`);
              }
              
              if (isAdFinished) {
                break;
              }
              
              let csrfToken = "";
              try {
                  csrfToken = await task_page.evaluate(async () => {
                      const res = await fetch("https://fuli.gamer.com.tw/ajax/getCSRFToken.php?_=" + Date.now());
                      return (await res.text()).trim();
                  });
              } catch (e) {
                  logger.error(`獲取 CSRF Token 時發生錯誤: ${e.message}`);
              }

              if (csrfToken && !csrfToken.startsWith("<")) {
                try {
                  await task_page.evaluate(async ({ token, sn }) => {
                      await fetch('https://fuli.gamer.com.tw/ajax/finish_ad.php', {
                          method: 'POST',
                          headers: { "Content-Type": "application/x-www-form-urlencoded" },
                          body: "token=" + encodeURIComponent(token) + "&area=item&sn=" + encodeURIComponent(sn)
                      });
                  }, { token: csrfToken, sn: snValue });
                  
                  logger.success(`[${name}] 成功發送跳過廣告請求`);
                  await task_page.waitForTimeout(1500);
                  break;
                } catch (error) {
                  logger.error(`發送已看廣告請求時發生錯誤: ${error.message}`);
                }
              }
              
              await task_page.waitForTimeout(1000);
            }

            await task_page.goto(`https://fuli.gamer.com.tw/buyD.php?ad=1&sn=${snValue}`);
            await task_page.waitForTimeout(1000);

            const final_url = task_page.url();
            const pageContent = await task_page.content();
            const AdCoupon = pageContent.includes("廣告抽獎券");

            if (final_url.includes("/buyD.php") && final_url.includes("ad=1") && AdCoupon) {
              logger.log(`正在確認結算頁面`);
              await checkInfo(task_page, logger).catch((...args) => logger.error(...args));
              await confirm(task_page, logger, recaptcha).catch((...args) => logger.error(...args));
              
              if (await task_page.$(".card > .section > p") && await task_page.$eval(".card > .section > p", (elm) => elm.innerText.includes("成功"))) {
                logger.success(`已完成一次抽抽樂：${name} \u001b[92m✔\u001b[m`);
                lottery++;
              } else {
                logger.warn(final_url);
                logger.warn(`廣告抽獎券: ${AdCoupon}`);
                logger.error("發生錯誤，重試中 \u001b[91m✘\u001b[m");
              }
            } else {
              logger.warn(final_url);
              logger.error("未進入正確的結算頁面，重試中 \u001b[91m✘\u001b[m");
            }
          } catch (err) {
            logger.error("!", err);
          }
        }
        await task_page.close();
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
          await timeout_promise(solve(page, { delay: 64 }), 30000);
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
    body += `✨✨✨ 獲得 **${lottery}** 個抽獎機會，價值 **${(lottery * 500).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}** 巴幣 ✨✨✨\n`;

    const unfinishedKeys = Object.keys(unfinished);
    if (unfinishedKeys.length > 0) {
        body += `\n🔴 以下 ${unfinishedKeys.length} 個抽抽樂未能成功完成兌換:\n`;
        unfinishedKeys.forEach((key) => {
            if (unfinished[key]) {
                 body += `- [${key}](${unfinished[key]})\n`;
            }
        });
    } else {
        body += "🟢 所有抽獎皆已完成\n";
    }
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