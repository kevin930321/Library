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

    const itemLogger = {
      log: (...args) => {
        console.log(args.join(" "));
      },
      info: (...args) => {
        console.log(`\u001b[34m` + args.join(" ") + `\u001b[0m`);
      },
      warn: (...args) => {
        console.log(`\u001b[33m` + args.join(" ") + `\u001b[0m`);
      },
      error: (...args) => {
        console.log(`\u001b[31m` + args.join(" ") + `\u001b[0m`);
      },
      success: (...args) => {
        console.log(`\u001b[32m` + args.join(" ") + `\u001b[0m`);
      },
    };
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
          console.log(`::group:: [${idx + 1} / ${draws.length}] ${name} (Attempt ${attempts})`);
          try {
            await task_page.goto(link);
            await task_page.waitForSelector("#BH-master > .BH-lbox.fuli-pbox h1");
            await task_page.waitForTimeout(100);
            if (await task_page.$(".btn-base.c-accent-o.is-disable")) {
              itemLogger.log(`${name} 的廣告免費次數已用完 \u001b[92m✔\u001b[m`);
              delete unfinished[name];
              console.log("::endgroup::");
              break;
            }
            itemLogger.log(`開始執行`);
            for (let retried = 1; retried <= CHANGING_RETRY; retried++) {
              let adButtonLocator = task_page.locator('a[onclick^="window.FuliAd.checkAd"]');
              if (!(await adButtonLocator.isVisible())) {
                itemLogger.warn('沒有發現廣告兌換按鈕, 可能為商品次數用盡或是已過期。');
                break;
              }
              let questionButton = await task_page.locator('a[onclick^="showQuestion(1);"]');
              if (await questionButton.isVisible()) {
                itemLogger.log("需要回答問題，正在回答問題");
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
                  await task_page.reload();
                  await task_page.waitForLoadState('networkidle');
                } catch (error) {
                  itemLogger.error("post 回答問題時發生錯誤,正在重試中");
                  break;
                }
              }
              const urlParams = new URLSearchParams(task_page.url().split('?')[1]);
              const snValue = urlParams.get('sn');
              itemLogger.log('sn:', encodeURIComponent(snValue));
              try {
                const response = await task_page.request.get("https://fuli.gamer.com.tw/ajax/check_ad.php?area=item&sn=" + encodeURIComponent(snValue));
                const data = JSON.parse(await response.text());
                if (data.data && data.data.finished === 1) {
                  itemLogger.info("廣告已跳過");
                  break;
                }
              } catch (e) {
                itemLogger.error('解析廣告狀態檢查的請求發生錯誤, 正在重試中:', e);
                break;
              }
              const tokenResponse = await task_page.request.get("https://fuli.gamer.com.tw/ajax/getCSRFToken.php?_=1702883537159");
              const csrfToken = (await tokenResponse.text()).trim();
              try {
                await task_page.request.post('https://fuli.gamer.com.tw/ajax/finish_ad.php', {
                  headers: {
                    "Content-Type": "application/x-www-form-urlencoded"
                  },
                  data: "token=" + encodeURIComponent(csrfToken) + "&area=item&sn=" + encodeURIComponent(snValue)
                });
              } catch (error) {
                itemLogger.error("發送已看廣告請求時發生錯誤:", error);
                break;
              }
              break;
            }
            await Promise.all([
              task_page.waitForResponse(/ajax\/check_ad.php/, { timeout: 5e3 }).catch(() => { }),
              task_page.click("text=看廣告免費兌換").catch(() => { })
            ]);
            await task_page.waitForTimeout(1e3);
            const final_url = task_page.url();
            if (final_url.includes("/buyD.php") && final_url.includes("ad=1")) {
              itemLogger.log(`正在確認結算頁面`);
              await checkInfo(task_page, itemLogger).catch((...args) => itemLogger.error(...args));
              await confirm(task_page, itemLogger, recaptcha).catch((...args) => itemLogger.error(...args));
              if (await task_page.$(".card > .section > p") && await task_page.$eval(".card > .section > p", (elm) => elm.innerText.includes("成功"))) {
                itemLogger.success(`已完成一次抽抽樂：${name} \u001b[92m✔\u001b[m`);
                lottery++;
              } else {
                itemLogger.warn(final_url);
                itemLogger.error("發生錯誤，重試中 \u001b[91m✘\u001b[m");
              }
            } else {
              itemLogger.warn(final_url);
              itemLogger.error("未進入結算頁面，重試中 \u001b[91m✘\u001b[m");
            }
          } catch (err) {
            itemLogger.error("!", err);
          } finally {
            console.log("::endgroup::");
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
  },
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

async function checkInfo(page, itemLogger) {
  try {
    const name = await page.$eval("#name", (elm) => elm.value);
    const tel = await page.$eval("#tel", (elm) => elm.value);
    const city = await page.$eval("[name=city]", (elm) => elm.value);
    const country = await page.$eval("[name=country]", (elm) => elm.value);
    const address = await page.$eval("#address", (elm) => elm.value);
    if (!name) itemLogger.log("無收件人姓名");
    if (!tel) itemLogger.log("無收件人電話");
    if (!city) itemLogger.log("無收件人城市");
    if (!country) itemLogger.log("無收件人區域");
    if (!address) itemLogger.log("無收件人地址");
    if (!name || !tel || !city || !country || !address)
      throw new Error("警告：收件人資料不全");
  } catch (err) {
    itemLogger.error(err);
  }
}

async function confirm(page, itemLogger, recaptcha) {
  try {
    await page.waitForSelector("input[name='agreeConfirm']", { state: "attached" });
    if (await (await page.$("input[name='agreeConfirm']")).getAttribute("checked") === null) {
      await page.click("text=我已閱讀注意事項，並確認兌換此商品");
    }
    await page.waitForTimeout(100);
    await page.waitForSelector("a:has-text('確認兌換')");
    await page.click("a:has-text('確認兌換')");
    const next_navigation = page.waitForNavigation().catch(() => { });
    await page.waitForSelector("button:has-text('確定')");
    await page.click("button:has-text('確定')");
    await page.waitForTimeout(300);
    if (recaptcha.process === true) {
      const recaptcha_frame_width = await page.$eval("iframe[src^='https://www.google.com/recaptcha/api2/bframe']", (elm) => getComputedStyle(elm).width);
      if (recaptcha_frame_width !== "100%") {
        itemLogger.log("需要處理 reCAPTCHA");
        try {
          await timeout_promise(solve(page, { delay: 64 }), 3e4);
        } catch (err) {
          if (err instanceof NotFoundError) {
            itemLogger.error("reCAPTCHA [Try it later]");
          }
          throw err;
        }
        itemLogger.log("reCAPTCHA 自動處理完成");
      }
    }
    await next_navigation;
  } catch (err) {
    itemLogger.error(page.url());
    itemLogger.error(err);
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