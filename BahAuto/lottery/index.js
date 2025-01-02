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
        // 處理 reCAPTCHA 的 response
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

           try { // 新增 try...catch
              await task_page.goto(link, { waitUntil: 'domcontentloaded' });
             await task_page.waitForSelector("#BH-master > .BH-lbox.fuli-pbox h1");
             await task_page.waitForTimeout(100);
           } catch (err) {
              logger.error("導航網頁時發生錯誤",err);
                 continue;
                 }


            if (await task_page.$(".btn-base.c-accent-o.is-disable")) {
              logger.log(`${name} 的廣告免費次數已用完 \u001b[92m✔\u001b[m`);
                delete unfinished[name];
              break;
            }


            logger.log(`[${idx + 1} / ${draws.length}] (${attempts}) ${name}`);
           // -----  新的廣告處理邏輯 start -----

           let adButtonLocator = await task_page.locator('a[onclick^="window.FuliAd.checkAd"]');


           //判斷問題
            let questionButton = await task_page.locator('a[onclick^="showQuestion(1);"]')
            if(await questionButton.isVisible()){
              logger.info("發現問題，嘗試回答")
               const tokenResponse = await task_page.request.get("https://fuli.gamer.com.tw/ajax/getCSRFToken.php?_=1702883537159")
                 const csrfToken = (await tokenResponse.text()).trim()

                  const templateContent = await task_page.locator("#question-popup").innerHTML()
                   let questionNumbers = [];
                     let regex = /data-question="(\d+)"/g;
                       let match;

                       while ((match = regex.exec(templateContent)) !== null) {
                        questionNumbers.push(match[1]);
                         }

                         let answers = [];
                      for(let question of questionNumbers){
                        const answer =  await task_page.locator(`.fuli-option[data-question="${question}"]`).getAttribute("data-answer");
                            answers.push(answer);
                           }
                       //準備表單數據
                          let formData = {};
                          const urlParams = new URLSearchParams(task_page.url().split('?')[1]);
                          let snValue = urlParams.get('sn');

                                  formData['sn'] = snValue;
                                 formData['token'] = csrfToken;

                              answers.forEach((ans, index) => {
                             formData[`answer[${index}]`] = ans
                                   });

                         try {
                             await task_page.request.post("https://fuli.gamer.com.tw/ajax/answer_question.php",{
                              form: formData
                             })
                           await task_page.reload();

                            } catch(error){
                             logger.error("post 回答問題時發生錯誤", error)
                           continue
                         }
                      logger.info("成功回答問題！")
                   await task_page.waitForLoadState('networkidle');

                 }

            //判斷是否有兌換按鈕
               if( !(await adButtonLocator.isVisible())){
                 logger.warn('沒有發現廣告兌換按鈕!');
                 continue;
                };




              const skipAdProcess = async () =>{
               //發送 get 檢查是否已經看過廣告
                   const urlParams = new URLSearchParams(task_page.url().split('?')[1]);
                 const snValue = urlParams.get('sn');

              try {
                   const response =  await task_page.request.get( "https://fuli.gamer.com.tw/ajax/check_ad.php?area=item&sn=" + encodeURIComponent(snValue));
                   const data = JSON.parse(await response.text());
                     if(data.data && data.data.finished ===1){
                         logger.log("你已經看過或跳過廣告!")
                             await adButtonLocator.click()
                           return
                           }

                     } catch (e) {
                        logger.error('解析看廣告檢查的請求發生錯誤：', e);
                                  return;
                                     }

                    // 獲取 CSRF token
                       const tokenResponse = await task_page.request.get("https://fuli.gamer.com.tw/ajax/getCSRFToken.php?_=1702883537159")
                         const csrfToken = (await tokenResponse.text()).trim()


                  // 發送 "已看廣告" 的請求
                      try{
                                  await task_page.request.post('https://fuli.gamer.com.tw/ajax/finish_ad.php', {
                                  headers: {
                                    "Content-Type": "application/x-www-form-urlencoded"
                                    },
                                       data: "token=" + encodeURIComponent(csrfToken) + "&area=item&sn=" + encodeURIComponent(snValue)
                                     })

                             }catch(e){
                              logger.error("請求發送'已看過廣告'時發生錯誤：", e)
                                       return;

                            }

                     try{
                           await Promise.all([task_page.waitForNavigation(), adButtonLocator.click() ]);

                        }
                       catch(e){
                            logger.error("點擊兌換按鈕時發生錯誤", e)
                            return
                       }


                                      //監看彈窗視窗
                          try {
                             await task_page.waitForSelector(".dialogify__content");
                          }catch(e){
                                    logger.warn("跳窗彈窗時間過長", e);
                                       return
                                }
                       //找到按鈕，並設置取消鈕點擊事件。
                       let confirmButton = await task_page.locator('.btn-box .btn-insert.btn-primary')
                       await confirmButton.evaluate((e) =>{e.disabled = true;  e.style.backgroundColor ="#e5e5e5"})

                        let cancelButton = await task_page.locator('.btn-box .btn-insert:not(.btn-primary)')
                              if (await cancelButton.isVisible()){
                                await cancelButton.click();
                            }
                  }
                await skipAdProcess();
                 logger.log("已跳過廣告");


         // ----- 新的廣告處理邏輯 end  -----


           /*  //舊邏輯先註解
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
                 */


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

                  try {
                           await task_page.reload(); //嘗試重新載入頁面
                         } catch(err){
                           logger.error("網頁重整失敗，無法執行重試流程：", err)
                      }


                   continue; //跳過之後所有動作，開始下次重試
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


// 獲取列表的函式 (與原程式碼相同，省略)
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

// 檢查資料的函式 (與原程式碼相同，省略)
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


// 確認的函式 (與原程式碼相同，省略)
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

export {
   lottery_default as default
};
