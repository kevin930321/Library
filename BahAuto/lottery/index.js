import { NotFoundError, solve } from "recaptcha-solver";
import { Pool } from "@jacoblincool/puddle";

const lottery_default = {
  name: "福利社",
  description: "福利社抽獎",
  async run({ page, shared, params, logger }) {
    if (!shared.flags.logged) throw new Error("使用者未登入，無法抽獎");
    if (!shared.ad_handler) throw new Error("需使用 ad_handler 模組");

    // 加入隨機延遲，模擬使用者行為
    await page.waitForTimeout(randomDelay(500, 1500));

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

    // 使用更自然的變數名稱
    const browserContext = page.context();
    const taskPool = new Pool(PARRALLEL);

    for (let i = 0; i < draws.length; i++) {
      taskPool.push(async () => {
        const taskIndex = i;
        const { link, name } = draws[taskIndex];

        // 每次都使用新的 page，避免被偵測到是同一個瀏覽器實例
        const taskPage = await browserContext.newPage();

        // 加入更多隨機、人性化的操作
        await taskPage.setViewportSize({
          width: 1280 + Math.floor(Math.random() * 100),
          height: 720 + Math.floor(Math.random() * 100),
        });
        await taskPage.setUserAgent(getRandomUserAgent()); // 使用隨機的 User-Agent

        const recaptcha = { process: false };

        // 使用更精準的事件監聽，避免不必要的處理
        taskPage.on("response", async (response) => {
          const url = response.url();
          if (url.includes("recaptcha/api2/userverify")) {
            const text = (await response.text()).replace(")]}'\n", "");
            try {
              const data = JSON.parse(text);
              recaptcha.process = data[2] === 0;
            } catch (e) {
              logger.error("解析 userverify 響應錯誤:", e);
            }
          } else if (url.includes("recaptcha/api2/reload")) {
            const text = (await response.text()).replace(")]}'\n", "");
            try {
              const data = JSON.parse(text);
              recaptcha.process = data[5] !== "nocaptcha";
            } catch (e) {
              logger.error("解析 reload 響應錯誤:", e);
            }
          }
        });

        for (let attempts = 1; attempts <= MAX_ATTEMPTS; attempts++) {
          try {
            // 加入隨機的滑鼠移動和點擊
            await humanLikeNavigation(taskPage, link);

            // 使用更具體的選擇器
            await taskPage.waitForSelector("#BH-master > .BH-lbox.fuli-pbox h1");
            await taskPage.waitForTimeout(randomDelay(100, 300));

            if (await taskPage.$(".btn-base.c-accent-o.is-disable")) {
              logger.log(
                `${name} 的廣告免費次數已用完 \u001b[92m✔\u001b[m`
              );
              delete unfinished[name];
              break;
            }

            logger.log(
              `[${taskIndex + 1} / ${draws.length}] (${attempts}) ${name}`
            );

            for (let retried = 1; retried <= CHANGING_RETRY; retried++) {

               // 使用更自然的變數命名及加入模擬人類的點擊
              const adButton = taskPage.locator(
                'a[onclick^="window.FuliAd.checkAd"]'
              );
              if (!(await adButton.isVisible())) {
                logger.warn(
                  "沒有發現廣告兌換按鈕, 可能為商品次數用盡或是已過期。"
                );
                break;
              }

              const questionButton = taskPage.locator(
                'a[onclick^="showQuestion(1);"]'
              );
              if (await questionButton.isVisible()) {
                logger.log("需要回答問題，正在回答問題");
                const tokenResponse = await taskPage.request.get(
                  "https://fuli.gamer.com.tw/ajax/getCSRFToken.php?_=" +
                    Date.now()
                );
                const csrfToken = (await tokenResponse.text()).trim();
                const templateContent = await taskPage
                  .locator("#question-popup")
                  .innerHTML();
                const questionNumbers = [];
                const regex = /data-question="(\d+)"/g;
                let match;
                while ((match = regex.exec(templateContent)) !== null) {
                  questionNumbers.push(match[1]);
                }
                const answers = [];
                for (const question of questionNumbers) {
                  const answer = await taskPage
                    .locator(`.fuli-option[data-question="${question}"]`)
                    .getAttribute("data-answer");
                  answers.push(answer);
                }
                const formData = {};
                const urlParams = new URLSearchParams(
                  taskPage.url().split("?")[1]
                );
                const snValue = urlParams.get("sn");
                formData["sn"] = snValue;
                formData["token"] = csrfToken;
                answers.forEach((ans, index) => {
                  formData[`answer[${index}]`] = ans;
                });
                try {
                  await taskPage.request.post(
                    "https://fuli.gamer.com.tw/ajax/answer_question.php",
                    {
                      form: formData,
                    }
                  );
                  await taskPage.reload({ waitUntil: "networkidle" });
                  //await taskPage.waitForLoadState("networkidle");
                } catch (error) {
                  logger.error("post 回答問題時發生錯誤,正在重試中");
                  break;
                }
              }
              const urlParams = new URLSearchParams(
                taskPage.url().split("?")[1]
              );
              const snValue = urlParams.get("sn");
              logger.log("sn:", encodeURIComponent(snValue));
              try {
                const response = await taskPage.request.get(
                  "https://fuli.gamer.com.tw/ajax/check_ad.php?area=item&sn=" +
                    encodeURIComponent(snValue)
                );
                const data = JSON.parse(await response.text());
                if (data.data && data.data.finished === 1) {
                  logger.info("廣告已跳過");
                  break;
                }
              } catch (e) {
                logger.error(
                  "解析廣告狀態檢查的請求發生錯誤, 正在重試中:",
                  e
                );
                break;
              }
              const tokenResponse = await taskPage.request.get(
                "https://fuli.gamer.com.tw/ajax/getCSRFToken.php?_=" +
                  Date.now()
              );
              const csrfToken = (await tokenResponse.text()).trim();
              try {
                await taskPage.request.post(
                  "https://fuli.gamer.com.tw/ajax/finish_ad.php",
                  {
                    headers: {
                      "Content-Type": "application/x-www-form-urlencoded",
                    },
                    data:
                      "token=" +
                      encodeURIComponent(csrfToken) +
                      "&area=item&sn=" +
                      encodeURIComponent(snValue),
                  }
                );
              } catch (error) {
                logger.error("發送已看廣告請求時發生錯誤:", error);
                break;
              }
              break;
            }

             // 使用更自然的點擊方式，並加入隨機延遲
             await humanLikeClick(taskPage, "text=看廣告免費兌換");
             await taskPage.waitForTimeout(randomDelay(500, 1500));

            const finalUrl = taskPage.url();
            if (finalUrl.includes("/buyD.php") && finalUrl.includes("ad=1")) {
              logger.log(`正在確認結算頁面`);

              // 加入更多錯誤處理
              try {
                await checkInfo(taskPage, logger);
              } catch (infoError) {
                logger.error("檢查資訊錯誤:", infoError);
              }

              try {
                await confirm(taskPage, logger, recaptcha);
              } catch (confirmError) {
                logger.error("確認頁面錯誤:", confirmError);
              }

              if (
                (await taskPage.$(".card > .section > p")) &&
                (await taskPage.$eval(".card > .section > p", (elm) =>
                  elm.innerText.includes("成功")
                ))
              ) {
                logger.success(
                  `已完成一次抽抽樂：${name} \u001b[92m✔\u001b[m`
                );
                lottery++;
              } else {
                logger.warn(finalUrl);
                logger.error("發生錯誤，重試中 \u001b[91m✘\u001b[m");
              }
            } else {
              logger.warn(finalUrl);
              logger.error("未進入結算頁面，重試中 \u001b[91m✘\u001b[m");
            }
          } catch (err) {
            logger.error("!", err);
          }
        }

        // 每個 task 結束後都關閉 page
        await taskPage.close();
      });
    }

    await taskPool.go();
    await page.waitForTimeout(randomDelay(2000, 3000));
    logger.log(`執行完畢 ✨`);
    if (shared.report) {
      shared.report.reports["福利社抽獎"] = report({ lottery, unfinished });
    }
    return { lottery, unfinished };
  },
};

async function getList(page, logger) {
  let draws;
  await page
    .context()
    .addCookies([
      {
        name: "ckFuli_18UP",
        value: "1",
        domain: "fuli.gamer.com.tw",
        path: "/",
      },
    ]);

  // 使用 for 迴圈代替 while 迴圈
  for (let attempts = 3; attempts > 0; attempts--) {
    draws = [];
    try {
      // 加入人性化的導航
      await humanLikeNavigation(page, "https://fuli.gamer.com.tw/shop.php?page=1");

      let items = await page.$$("a.items-card");
      for (let i = items.length - 1; i >= 0; i--) {
        // 使用更精準的判斷方式
        const isDraw = await items[i].evaluate((elm) =>
          elm.innerHTML.includes("抽抽樂")
        );
        if (isDraw) {
          draws.push({
            name: await items[i].evaluate(
              (node) => node.querySelector(".items-title").innerHTML
            ),
            link: await items[i].evaluate((elm) => elm.href),
          });
        }
      }

      while (
        await page.$eval("a.pagenow", (elm) =>
          elm.nextSibling ? true : false
        )
      ) {
        const nextPageUrl =
          "https://fuli.gamer.com.tw/shop.php?page=" +
          (await page.$eval("a.pagenow", (elm) => elm.nextSibling.innerText));

        // 加入人性化的導航
        await humanLikeNavigation(page, nextPageUrl);

        let items2 = await page.$$("a.items-card");
        for (let i = items2.length - 1; i >= 0; i--) {
          const isDraw = await items2[i].evaluate((node) =>
            node.innerHTML.includes("抽抽樂")
          );
          if (isDraw) {
            draws.push({
              name: await items2[i].evaluate(
                (node) => node.querySelector(".items-title").innerHTML
              ),
              link: await items2[i].evaluate((elm) => elm.href),
            });
          }
        }
      }

      // 成功取得列表就跳出迴圈
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

    // 使用更精準的判斷
    if (!name) logger.warn("無收件人姓名");
    if (!tel) logger.warn("無收件人電話");
    if (!city) logger.warn("無收件人城市");
    if (!country) logger.warn("無收件人區域");
    if (!address) logger.warn("無收件人地址");

    if (!name || !tel || !city || !country || !address) {
      throw new Error("警告：收件人資料不全");
    }
  } catch (err) {
    logger.error(err);
  }
}

async function confirm(page, logger, recaptcha) {
  try {
    await page.waitForSelector("input[name='agreeConfirm']", {
      state: "attached",
    });

    // 使用更安全的判斷方式
    const isChecked = await page
      .locator("input[name='agreeConfirm']")
      .isChecked();
    if (!isChecked) {
      await humanLikeClick(page, "text=我已閱讀注意事項，並確認兌換此商品");
    }

    await page.waitForTimeout(randomDelay(100, 300));

    // 使用更精準的選擇器
    await page.waitForSelector("a:has-text('確認兌換')");
    await humanLikeClick(page, "a:has-text('確認兌換')");

    const nextNavigation = page.waitForNavigation().catch(() => {});

    // 使用更精準的選擇器
    await page.waitForSelector("button:has-text('確定')");
    await humanLikeClick(page, "button:has-text('確定')");

    await page.waitForTimeout(randomDelay(300, 600));

    if (recaptcha.process === true) {
      const recaptchaFrameWidth = await page.$eval(
        "iframe[src^='https://www.google.com/recaptcha/api2/bframe']",
        (elm) => getComputedStyle(elm).width
      );

      // 使用更安全的判斷方式
      if (recaptchaFrameWidth !== "100%") {
        logger.log("需要處理 reCAPTCHA");
        try {
          await timeout_promise(
            solve(page, {
              delay: randomDelay(50, 100),
              minimum_delay: randomDelay(40, 80),
            }),
            3e4
          );
        } catch (err) {
          if (err instanceof NotFoundError) {
            logger.error("reCAPTCHA [Try it later]");
          }
          throw err;
        }
        logger.log("reCAPTCHA 自動處理完成");
      }
    }
    await nextNavigation;
  } catch (err) {
    logger.error(page.url());
    logger.error(err);
  }
}

function report({ lottery, unfinished }) {
  let body = "# 福利社抽抽樂 \n\n";
  if (lottery) {
    body += `✨✨✨ 獲得 **${lottery}** 個抽獎機會，價值 **${(
      lottery * 500
    )
      .toString()
      .replace(/\B(?=(\d{3})+(?!\d))/g, ",")}** 巴幣 ✨✨✨\n`;
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

// 隨機產生指定範圍內的毫秒延遲
function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1) + min);
}

// 模擬人類的滑鼠移動和點擊
async function humanLikeClick(page, selector) {
  const element = await page.waitForSelector(selector);
  const box = await element.boundingBox();
  const x = box.x + box.width / 2 + (Math.random() - 0.5) * box.width / 2;
  const y = box.y + box.height / 2 + (Math.random() - 0.5) * box.height / 2;
  await page.mouse.move(x, y);
  await page.waitForTimeout(randomDelay(50, 150));
  await page.mouse.down();
  await page.waitForTimeout(randomDelay(50, 150));
  await page.mouse.up();
}

// 模擬人類的導航行為
async function humanLikeNavigation(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  const scrollHeight = await page.evaluate(() => document.body.scrollHeight);
  for (let i = 0; i < scrollHeight; i += randomDelay(50, 150)) {
    await page.evaluate((y) => {
      window.scrollTo(0, y);
    }, i);
    await page.waitForTimeout(randomDelay(10, 30));
  }
  await page.waitForTimeout(randomDelay(500, 1500));
}

// 隨機產生 User-Agent
function getRandomUserAgent() {
  const userAgents = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Safari/605.1.15",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:88.0) Gecko/20100101 Firefox/88.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.93 Safari/537.36",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 14_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0.3 Mobile/15E148 Safari/604.1",
    "Mozilla/5.0 (iPad; CPU OS 14_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0.3 Mobile/15E148 Safari/604.1",
    "Mozilla/5.0 (Linux; Android 11; SM-G998U) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.210 Mobile Safari/537.36",
    "Mozilla/5.0 (Linux; Android 11; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.91 Mobile Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Trident/7.0; rv:11.0) like Gecko",
  ];
  return userAgents[Math.floor(Math.random() * userAgents.length)];
}

export { lottery_default as default };