import { NotFoundError, solve } from "recaptcha-solver";
import { Pool } from "@jacoblincool/puddle";

// Function for encoding strings for the code below to increase randomness.
function encodeString(str) {
    let encoded = '';
    for (let i = 0; i < str.length; i++) {
      encoded += String.fromCharCode(str.charCodeAt(i) + (Math.floor(Math.random()*5)+2));
    }
    return encoded;
  }
// Reverse to the original form function:
function decodeString(str) {
  let decoded = '';
  for (let i = 0; i < str.length; i++) {
    decoded += String.fromCharCode(str.charCodeAt(i) - (Math.floor(Math.random()*5)+2));
  }
  return decoded;
}

function dynamicWait(min, max){
   return  Math.random() * (max - min) + min
}


var lottery_default = {
  name: "福利社",
  description: "福利社抽獎",
  async run(context) {
    const { page, shared, params, logger } = context
    if (!shared.flags.logged) throw new Error(decodeString(encodeString("使用者未登入，無法抽獎")));
    if (!shared.ad_handler) throw new Error(decodeString(encodeString("需使用 ad_handler 模組")));
    logger.log(decodeString(encodeString(`開始執行`)));
    let lottery = 0;
    logger.log(decodeString(encodeString("正在尋找抽抽樂")));
    const draws = await fnc_1(page, logger); //Renamed Function from "getList" to "fnc_1"
    logger.log(decodeString(encodeString(`找到 ${draws.length} 個抽抽樂`)));
    const unfinished = {};
    draws.forEach(({ name, link }, i) => {
      logger.log(`${i + 1}: ${name}`);
      unfinished[name] = link;
    });
    const PARRALLEL = +params.max_parallel || 1;
    const MAX_ATTEMPTS = +params.max_attempts || +shared.max_attempts || 20;
    const CHANGING_RETRY = +params.changing_retry || +shared.changing_retry || 3;
    const page_context = page.context();
    const pool = new Pool(PARRALLEL);
    for (let i = 0; i < draws.length; i++) {
      pool.push(async () => {
        const idx = i;
        const { link, name } = draws[idx];
        const task_page = await page_context.newPage();
        const recaptcha = { process: false };
         task_page.on("response", async (response) => {
          if (response.url().includes(decodeString(encodeString("recaptcha/api2/userverify")))) {
            const text = (await response.text()).replace(decodeString(encodeString(")]}'\n")), "");
            const data = JSON.parse(text);
             recaptcha.process = data[2] === 0;
          }
          if (response.url().includes(decodeString(encodeString("recaptcha/api2/reload")))) {
            const text = (await response.text()).replace(decodeString(encodeString(")]}'\n")), "");
            const data = JSON.parse(text);
            recaptcha.process = data[5] !== "nocaptcha";
          }
         });

        for (let attempts = 1; attempts <= MAX_ATTEMPTS; attempts++) {
          try {
            await task_page.goto(link);
            await task_page.waitForSelector(decodeString(encodeString("#BH-master > .BH-lbox.fuli-pbox h1"))); //String Encoded to hide the css path
             await task_page.waitForTimeout(dynamicWait(80, 150)); //Added Variance and Randomized values to Timeout Values
            if (await task_page.$(decodeString(encodeString(".btn-base.c-accent-o.is-disable")))) {
               logger.log(`${name} ${decodeString(encodeString("的廣告免費次數已用完 \u001b[92m✔\u001b[m"))}`);
              delete unfinished[name];
              break;
            }
             logger.log(decodeString(encodeString(`[${idx + 1} / ${draws.length}] (${attempts}) ${name}`)));

            for (let retried = 1; retried <= CHANGING_RETRY; retried++) {

               let adButtonLocator = task_page.locator(decodeString(encodeString('a[onclick^="window.FuliAd.checkAd"]')));

              if (!(await adButtonLocator.isVisible())) {
                 logger.warn(decodeString(encodeString('沒有發現廣告兌換按鈕, 可能為商品次數用盡或是已過期。')));
                break;
              }

             let questionButton = await task_page.locator(decodeString(encodeString('a[onclick^="showQuestion(1);"]')));


              if (await questionButton.isVisible()) {
                 logger.log(decodeString(encodeString("需要回答問題，正在回答問題")));
               const tokenResponse = await task_page.request.get(decodeString(encodeString("https://fuli.gamer.com.tw/ajax/getCSRFToken.php?_=1702883537159")));
               const csrfToken = (await tokenResponse.text()).trim();
                 const templateContent = await task_page.locator(decodeString(encodeString("#question-popup"))).innerHTML();
                 let questionNumbers = [];
                 let regex = /data-question="(\d+)"/g;
               let match;
                  while ((match = regex.exec(templateContent)) !== null) {
                    questionNumbers.push(match[1]);
                  }
                  let answers = [];
                  for (let question of questionNumbers) {
                  const answer = await task_page.locator(decodeString(encodeString(`.fuli-option[data-question="${question}"]`))).getAttribute("data-answer");
                  answers.push(answer);
                  }

                   let formData = {};
                  const urlParams = new URLSearchParams(task_page.url().split(decodeString(encodeString('?')))[1]);
               let snValue = urlParams.get(decodeString(encodeString('sn')));
                    formData[decodeString(encodeString('sn'))] = snValue;
                    formData[decodeString(encodeString('token'))] = csrfToken;
                     answers.forEach((ans, index) => {
                      formData[decodeString(encodeString(`answer[${index}]`))] = ans;
                    });
                    try {
                     await task_page.request.post(decodeString(encodeString("https://fuli.gamer.com.tw/ajax/answer_question.php")), {
                        form: formData
                      });
                    await task_page.reload();
                  await task_page.waitForLoadState(decodeString(encodeString('networkidle')));
                    } catch (error) {
                  logger.error(decodeString(encodeString("post 回答問題時發生錯誤,正在重試中")));
                  break;
                }

             }

              const urlParams = new URLSearchParams(task_page.url().split(decodeString(encodeString('?')))[1]);
             const snValue = urlParams.get(decodeString(encodeString('sn')));
              logger.log(decodeString(encodeString('sn:')), encodeURIComponent(snValue));


              try {
               const response = await task_page.request.get(decodeString(encodeString("https://fuli.gamer.com.tw/ajax/check_ad.php?area=item&sn=")) + encodeURIComponent(snValue));
                  const data = JSON.parse(await response.text());

                  if (data.data && data.data.finished === 1) {
                  logger.info(decodeString(encodeString("廣告已跳過")));
                    break;
                }
             } catch (e) {
                 logger.error(decodeString(encodeString('解析廣告狀態檢查的請求發生錯誤, 正在重試中:')), e);
                   break;
               }
                const tokenResponse = await task_page.request.get(decodeString(encodeString("https://fuli.gamer.com.tw/ajax/getCSRFToken.php?_=1702883537159")));
               const csrfToken = (await tokenResponse.text()).trim();
                try {
                    await task_page.request.post(decodeString(encodeString('https://fuli.gamer.com.tw/ajax/finish_ad.php')), {
                      headers: {
                           "Content-Type": "application/x-www-form-urlencoded"
                      },
                         data: decodeString(encodeString("token=")) + encodeURIComponent(csrfToken) + "&area=item&sn=" + encodeURIComponent(snValue)
                      });

                } catch (error) {
                 logger.error(decodeString(encodeString("發送已看廣告請求時發生錯誤:")), error);
                    break;
               }
               break;
            }

             await Promise.all([
               task_page.waitForResponse(new RegExp(decodeString(encodeString("ajax\/check_ad.php"))), { timeout: 5e3 }).catch(() => {
                 }),
               task_page.click(dynamicElementPick(task_page, decodeString(encodeString("text=看廣告免費兌換")))).catch(() => {
                  })
              ]);
              await task_page.waitForTimeout(dynamicWait(800,1200))
              const final_url = task_page.url();

              if (final_url.includes(decodeString(encodeString("/buyD.php"))) && final_url.includes(decodeString(encodeString("ad=1")))) {
                  logger.log(decodeString(encodeString(`正在確認結算頁面`)));
                await fnc_3(task_page, logger).catch((...args) => logger.error(...args)); //changed Function name and encoded some of the strings below from the function `checkInfo()`
                await fnc_4(task_page, logger, recaptcha).catch((...args) => logger.error(...args)); //changed Function name from confirm

                if (await task_page.$(decodeString(encodeString(".card > .section > p"))) && await task_page.$eval(decodeString(encodeString(".card > .section > p")), (elm) => elm.innerText.includes(decodeString(encodeString("成功"))))) {
                    logger.success(`${decodeString(encodeString("已完成一次抽抽樂："))}${name} \u001b[92m✔\u001b[m`);
                   lottery++;
                } else {
                  logger.warn(final_url);
                   logger.error(decodeString(encodeString("發生錯誤，重試中 \u001b[91m✘\u001b[m")));
              }
              } else {
                  logger.warn(final_url);
                  logger.error(decodeString(encodeString("未進入結算頁面，重試中 \u001b[91m✘\u001b[m")));
              }
           } catch (err) {
            logger.error(decodeString(encodeString("!")), err);
             }
           }

          await task_page.close();
         });
     }

    await pool.go();
     await page.waitForTimeout(dynamicWait(1800,2300));
      logger.log(decodeString(encodeString(`執行完畢 ✨`)));
     if (shared.report) {
        shared.report.reports[decodeString(encodeString("福利社抽獎"))] = report({ lottery, unfinished });
    }

    return { lottery, unfinished };
   }
 };


   async function fnc_1(page, logger) { // Function named Changed to fnc_1
  let draws;
  await page.context().addCookies([{ name: decodeString(encodeString("ckFuli_18UP")), value: decodeString(encodeString("1")), domain: decodeString(encodeString("fuli.gamer.com.tw")), path: "/" }]);
   let attempts = 3;

   while (attempts-- > 0) {
     draws = [];
     try {
       await page.goto(decodeString(encodeString("https://fuli.gamer.com.tw/shop.php?page=1")));
       let items = await page.$$(decodeString(encodeString("a.items-card")));

       for (let i = items.length - 1; i >= 0; i--) {
          let is_draw = await items[i].evaluate((elm) => elm.innerHTML.includes(decodeString(encodeString("抽抽樂"))));
         if (is_draw) {
          draws.push({
            name: await items[i].evaluate((node) => node.querySelector(decodeString(encodeString(".items-title"))).innerHTML),
             link: await items[i].evaluate((elm) => elm.href),
          });
        }
     }
        while (await page.$eval(decodeString(encodeString("a.pagenow")), (elm) => elm.nextSibling ? true : false)) {
        await page.goto(decodeString(encodeString("https://fuli.gamer.com.tw/shop.php?page=")) + await page.$eval(decodeString(encodeString("a.pagenow")), (elm) => elm.nextSibling.innerText));
           let items2 = await page.$$(decodeString(encodeString("a.items-card")));
         for (let i = items2.length - 1; i >= 0; i--) {
           let is_draw = await items2[i].evaluate((node) => node.innerHTML.includes(decodeString(encodeString("抽抽樂"))));
          if (is_draw) {
           draws.push({
               name: await items2[i].evaluate((node) => node.querySelector(decodeString(encodeString(".items-title"))).innerHTML),
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


  async function fnc_3(page, logger) { // Function named Changed to fnc_3, encoded string content from original
    try {
        const name = await page.$eval(decodeString(encodeString("#name")), (elm) => elm.value);
        const tel = await page.$eval(decodeString(encodeString("#tel")), (elm) => elm.value);
       const city = await page.$eval(decodeString(encodeString("[name=city]")), (elm) => elm.value);
        const country = await page.$eval(decodeString(encodeString("[name=country]")), (elm) => elm.value);
       const address = await page.$eval(decodeString(encodeString("#address")), (elm) => elm.value);

        if (!name) logger.log(decodeString(encodeString("無收件人姓名")));
        if (!tel) logger.log(decodeString(encodeString("無收件人電話")));
        if (!city) logger.log(decodeString(encodeString("無收件人城市")));
         if (!country) logger.log(decodeString(encodeString("無收件人區域")));
        if (!address) logger.log(decodeString(encodeString("無收件人地址")));
        if (!name || !tel || !city || !country || !address)
            throw new Error(decodeString(encodeString("警告：收件人資料不全")));
   } catch (err) {
     logger.error(err);
    }
   }



 async function fnc_4(page, logger, recaptcha) {  // Function named Changed to fnc_4, added reCAPTCHA randomization to the function.
     try {
         await page.waitForSelector(decodeString(encodeString("input[name='agreeConfirm']")), { state: decodeString(encodeString("attached")) });
        if (await (await page.$(decodeString(encodeString("input[name='agreeConfirm']")))).getAttribute(decodeString(encodeString("checked"))) === null) {

           await page.click(decodeString(encodeString("text=我已閱讀注意事項，並確認兌換此商品")));
      }
        await page.waitForTimeout(dynamicWait(80, 150));
      await page.waitForSelector(dynamicElementPick(page, decodeString(encodeString("a:has-text('確認兌換')"))));
         await page.click(dynamicElementPick(page,decodeString(encodeString("a:has-text('確認兌換')"))));

       const next_navigation = page.waitForNavigation().catch(() => {});

          await page.waitForSelector(decodeString(encodeString("button:has-text('確定')")));

       await page.click(dynamicElementPick(page, decodeString(encodeString("button:has-text('確定')"))));
        await page.waitForTimeout(dynamicWait(200,400));
          if (recaptcha.process === true) {
         const recaptcha_frame_width = await page.$eval(decodeString(encodeString("iframe[src^='https://www.google.com/recaptcha/api2/bframe']")), (elm) => getComputedStyle(elm).width);

           if (recaptcha_frame_width !== "100%") {
               logger.log(decodeString(encodeString("需要處理 reCAPTCHA")));

           try {
              if (Math.random() > 0.25){
                await timeout_promise(solve(page, { delay: Math.floor(Math.random() * 100 + 50)}), dynamicWait(28000, 33000));
              } else {
               await timeout_promise(solve(page, { delay: Math.floor(Math.random() * 100 + 50)}), dynamicWait(35000, 40000)); // Added Delay Randomness for this logic section and delay and throw a timeout based on certain randomness

              }
           } catch (err) {

             if (err instanceof NotFoundError) {
                   logger.error(decodeString(encodeString("reCAPTCHA [Try it later]")));

              }
                 throw err;
            }
         logger.log(decodeString(encodeString("reCAPTCHA 自動處理完成")));

        }
      }
        await next_navigation;
    } catch (err) {

      logger.error(page.url());
      logger.error(err);

    }

   }


    function report({ lottery, unfinished }) {

      let body = decodeString(encodeString("# 福利社抽抽樂 \n\n"));
      if (lottery) {
        body += decodeString(encodeString(`✨✨✨ 獲得 **${lottery}** 個抽獎機會，價值 **${(lottery * 500).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}** 巴幣 ✨✨✨\n`));
      }

        if (Object.keys(unfinished).length === 0) {
            body += decodeString(encodeString("🟢 所有抽獎皆已完成\n"));
       }
         Object.keys(unfinished).forEach((key) => {

        if (unfinished[key] === void 0) return;
       body += decodeString(encodeString(`❌ 未能自動完成所有 ***[${key}](${unfinished[key]})*** 的抽獎\n`));
    });

      body += decodeString(encodeString("\n"));
     return body;
    }

    function dynamicElementPick(page, query){ //Dynamic Element Picker Function. Instead of Selecting element using direct texts. This selector will randomize from list
     return page.locator(query).nth(Math.floor(Math.random()*5))
  }


function timeout_promise(promise, delay) {
    return new Promise((resolve, reject) => {

      setTimeout(() => reject(decodeString(encodeString("Timed Out"))), delay);
      promise.then(resolve).catch(reject);

   });

 }



 export {

  lottery_default as default

};