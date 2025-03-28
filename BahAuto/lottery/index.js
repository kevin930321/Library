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
        let task_page;
        try {
          task_page = await context.newPage();

          await task_page.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] }); // Simple fake plugins
            Object.defineProperty(navigator, 'languages', { get: () => ['zh-TW', 'zh'] }); // Fake languages
            if (window.chrome) {
              // delete window.chrome; // Potentially breaking, test carefully
              window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {} }; // Minimal fake chrome object
            }
          });

          const recaptcha = { process: false };
          task_page.on("response", async (response) => {
            try {
              if (response.ok() && response.url().includes("recaptcha/api2/")) {
                const url = response.url();
                if (url.includes("userverify")) {
                  const text = (await response.text()).replace(")]}'\n", "");
                  const data = JSON.parse(text);
                  recaptcha.process = data[2] === 0;
                } else if (url.includes("reload")) {
                  const text = (await response.text()).replace(")]}'\n", "");
                  const data = JSON.parse(text);
                  recaptcha.process = data[5] !== "nocaptcha";
                }
              }
            } catch (err) {
                logger.warn(`處理 reCAPTCHA response 出錯: ${err.message}`);
            }
          });

          let attempt_success = false;
          for (let attempts = 1; attempts <= MAX_ATTEMPTS; attempts++) {
            try {
              await task_page.goto(link, { waitUntil: 'domcontentloaded', timeout: 60000 });
              await task_page.locator("#BH-master > .BH-lbox.fuli-pbox h1").waitFor({ state: 'visible', timeout: 30000 });
              await task_page.waitForTimeout(500);

              const disableButton = task_page.locator(".btn-base.c-accent-o.is-disable");
              if (await disableButton.isVisible({ timeout: 5000 })) {
                logger.log(`${name} 的廣告免費次數已用完 \u001b[92m✔\u001b[m`);
                delete unfinished[name];
                attempt_success = true;
                break;
              }
              logger.log(`[${idx + 1} / ${draws.length}] (${attempts}/${MAX_ATTEMPTS}) ${name}`);

              const questionButton = task_page.locator('a[onclick^="showQuestion(1);"]');
              if (await questionButton.isVisible({ timeout: 5000 })) {
                 logger.log("需要回答問題，正在回答問題");
                 try {
                   const timestamp = Date.now();
                   const tokenResponse = await task_page.request.get(`https://fuli.gamer.com.tw/ajax/getCSRFToken.php?_=${timestamp}`, {
                     headers: { 'Referer': task_page.url(), 'X-Requested-With': 'XMLHttpRequest' }
                   });
                   const csrfToken = (await tokenResponse.text()).trim();
                   if (!csrfToken) throw new Error('未能獲取 CSRF Token');

                   const templateContent = await task_page.locator("#question-popup").innerHTML({ timeout: 10000 });
                   let questionNumbers = [];
                   let regex = /data-question="(\d+)"/g;
                   let match;
                   while ((match = regex.exec(templateContent)) !== null) {
                     questionNumbers.push(match[1]);
                   }
                   let answers = [];
                   for (let question of questionNumbers) {
                     const answer = await task_page.locator(`.fuli-option[data-question="${question}"]`).getAttribute("data-answer", { timeout: 5000 });
                     if (answer === null) throw new Error(`找不到問題 ${question} 的答案屬性`);
                     answers.push(answer);
                   }
                   let formData = {};
                   const urlParams = new URLSearchParams(task_page.url().split('?')[1]);
                   let snValue = urlParams.get('sn');
                   if (!snValue) throw new Error('未能從 URL 中獲取 sn 參數');
                   formData['sn'] = snValue;
                   formData['token'] = csrfToken;
                   answers.forEach((ans, index) => {
                     formData[`answer[${index}]`] = ans;
                   });

                    const answerPostResponse = await task_page.request.post("https://fuli.gamer.com.tw/ajax/answer_question.php", {
                       headers: {
                         'Referer': task_page.url(),
                         'X-Requested-With': 'XMLHttpRequest',
                         'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
                       },
                       form: formData,
                       failOnStatusCode: true
                     });

                    const answerJson = await answerPostResponse.json();
                    if(answerJson.error) {
                        throw new Error(`回答問題API回傳錯誤: ${answerJson.error.message || JSON.stringify(answerJson.error)}`);
                    }
                    logger.log("問題回答請求已發送，正在重新載入頁面");
                    await task_page.reload({ waitUntil: 'networkidle', timeout: 60000 });
                 } catch(questionError) {
                   logger.error(`處理問題時出錯: ${questionError.message}, 該次嘗試失敗，重試中...`);
                   await task_page.waitForTimeout(3000 + Math.random() * 2000);
                   continue;
                 }
              }


              logger.log("嘗試點擊兌換按鈕並等待跳轉至結算頁面...");
              const exchangeButtonLocator = task_page.locator('a:has-text("看廣告免費兌換"), a:has-text("我要兌換")');
              await exchangeButtonLocator.waitFor({ state: 'visible', timeout: 15000 });

              try {
                  await Promise.all([
                      task_page.waitForURL(/\/buyD\.php\?sn=\d+(?:&ad=1)?(?:&exchange=true)?/, { timeout: 45000, waitUntil: 'domcontentloaded' }),
                      exchangeButtonLocator.click({timeout: 15000}),
                  ]);
                  logger.log(`成功導航到結算頁面: ${task_page.url()}`);
                  await task_page.waitForLoadState('networkidle', { timeout: 25000 });
              } catch (navError) {
                 logger.error(`點擊兌換按鈕後導航失敗或超時: ${navError}. 當前 URL: ${task_page.url()}. 該次嘗試失敗，重試中...`);
                 await task_page.screenshot({ path: `error_nav_${name}_${attempts}.png`, fullPage: true }).catch(e=>logger.error(`截圖失敗: ${e}`));
                 await task_page.waitForTimeout(3000 + Math.random() * 2000);
                 continue;
              }

              const final_url = task_page.url();
              if (final_url.includes("/buyD.php")) {
                 logger.log(`正在確認結算頁面`);
                 await checkInfo(task_page, logger);
                 await confirm(task_page, logger, recaptcha);

                 const successMessageLocator = task_page.locator(".card > .section > p:text-matches('成功')");

                 try {
                    await successMessageLocator.waitFor({ state: 'visible', timeout: 15000 });
                    logger.success(`已完成一次抽抽樂：${name} \u001b[92m✔\u001b[m`);
                    lottery++;
                    delete unfinished[name];
                    attempt_success = true;
                    break;
                 } catch (e) {
                    logger.warn(`結算頁面未找到成功訊息或超時. URL: ${final_url}`);
                    const errorSection = task_page.locator(".card > .section");
                    const errorMessage = await errorSection.textContent({ timeout: 5000 }).catch(() => "無法獲取結算區塊內容");
                    logger.error(`錯誤或非預期結算頁面內容: ${errorMessage.trim()}. 該次嘗試失敗，重試中... \u001b[91m✘\u001b[m`);
                    await task_page.screenshot({ path: `error_confirm_${name}_${attempts}.png`, fullPage: true }).catch(e=>logger.error(`截圖失敗: ${e}`));
                    await task_page.waitForTimeout(3000 + Math.random() * 2000);
                    continue;
                 }
              } else {
                logger.warn(`未導航至預期的結算頁面. 實際 URL: ${final_url}`);
                logger.error("未進入結算頁面，重試中 \u001b[91m✘\u001b[m");
                 await task_page.screenshot({ path: `error_wrongpage_${name}_${attempts}.png`, fullPage: true }).catch(e=>logger.error(`截圖失敗: ${e}`));
                await task_page.waitForTimeout(3000 + Math.random() * 2000);
                continue;
              }
            } catch (err) {
              logger.error(`處理 "${name}" 抽獎時內部循環發生錯誤 (Attempt ${attempts}/${MAX_ATTEMPTS}): ${err.message}. Stack: ${err.stack}`);
              if (task_page.isClosed()) {
                  logger.error('頁面已關閉，無法繼續此任務');
                  break;
              }
               await task_page.screenshot({ path: `error_loop_${name}_${attempts}.png`, fullPage: true }).catch(e=>logger.error(`截圖失敗: ${e}`));
              await task_page.waitForTimeout(5000 + Math.random() * 3000);
            }
          }
          if (!attempt_success && unfinished[name]) {
             logger.error(`"${name}" 經過 ${MAX_ATTEMPTS} 次嘗試後仍未完成 \u001b[91m✘\u001b[m`);
          }
        } catch (outerError) {
             logger.error(`處理 "${name}" 任務時發生嚴重錯誤: ${outerError.message}. Stack: ${outerError.stack}`);
             if (task_page && !task_page.isClosed()) {
                await task_page.screenshot({ path: `error_fatal_${name}.png`, fullPage: true }).catch(e=>logger.error(`截圖失敗: ${e}`));
             }
        } finally {
            if (task_page && !task_page.isClosed()) {
                 await task_page.close();
            }
        }
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
    let currentPageNum = 1;
    try {
      while (true) {
        logger.log(`正在讀取商店列表第 ${currentPageNum} 頁`);
        await page.goto(`https://fuli.gamer.com.tw/shop.php?page=${currentPageNum}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForSelector("a.items-card, .home-noproduct", { timeout: 30000 });

        const items = await page.locator("a.items-card").elementHandles();

        if (items.length === 0) {
            const noProduct = await page.locator(".home-noproduct").isVisible({ timeout: 1000});
             if (noProduct || currentPageNum > 1) {
                logger.log("當前頁面沒有商品或顯示無商品訊息，判斷為最後一頁");
                break;
             } else {
                 throw new Error(`第 ${currentPageNum} 頁未找到商品且未顯示無商品提示`);
             }
        }

        for (let itemHandle of items) {
          try {
            const itemHTML = await itemHandle.innerHTML();
            if (itemHTML.includes("抽抽樂") || itemHTML.includes("抽獎")) { // Relax condition slightly
              const nameElement = await itemHandle.$(".items-title");
              const link = await itemHandle.getAttribute('href');
              if (nameElement && link && link.includes("detail.php")) {
                  const name = await nameElement.textContent();
                  draws.push({ name: name.trim(), link: new URL(link, page.url()).href }); // Store absolute URL
              }
            }
          } finally {
              await itemHandle.dispose();
          }
        }

        const nextPageButton = page.locator('a.pagenow + a[href^="shop.php?page="]');
        if (await nextPageButton.isVisible({ timeout: 5000 })) {
           const nextPageNumStr = await nextPageButton.textContent();
           const nextPageNum = parseInt(nextPageNumStr, 10);
           if (!isNaN(nextPageNum) && nextPageNum > currentPageNum) {
               currentPageNum = nextPageNum;
               await page.waitForTimeout(500 + Math.random()*500);
           } else {
               logger.log(`下一頁按鈕 (${nextPageNumStr}) 不是預期的數字或沒有增加, 停止翻頁`);
               break;
           }
        } else {
           logger.log("找不到下一頁按鈕，已到達列表末尾");
           break;
        }
      }
      break;
    } catch (err) {
      logger.error(`讀取商店列表第 ${currentPageNum} 頁失敗 (嘗試次數 ${3 - attempts}/3): ${err.message}`);
       if (page && !page.isClosed()) {
          await page.screenshot({ path: `error_getlist_page_${currentPageNum}_attempt_${3-attempts}.png` }).catch(e=>logger.error(`截圖失敗: ${e}`));
       }
      if (attempts <= 0) {
         logger.error(`多次嘗試讀取商店列表失敗後放棄`);
         return [];
      }
      await page.waitForTimeout(3000);
    }
  }
  logger.log(`列表讀取完成，共找到 ${draws.length} 個抽抽樂`);
  return draws;
}

async function checkInfo(page, logger) {
  try {
    const requiredFields = [
      { selector: "#name", name: "收件人姓名" },
      { selector: "#tel", name: "收件人電話" },
      { selector: "[name=city]", name: "收件人城市" },
      { selector: "[name=country]", name: "收件人區域" },
      { selector: "#address", name: "收件人地址" }
    ];
    let missingInfo = false;
    await page.locator(requiredFields[0].selector).waitFor({ state: 'attached', timeout: 15000 });

    for (const field of requiredFields) {
        const element = page.locator(field.selector);
        let value;
        if (field.name.includes('城市') || field.name.includes('區域')) {
             value = await element.inputValue({ timeout: 5000 }); // Dropdowns use value
        } else {
            value = await element.inputValue({ timeout: 5000 }); // Inputs use value
        }

        if (!value || value.trim() === '' || value === '0') {
            logger.warn(`警告：缺少 ${field.name}`);
            missingInfo = true;
        }
    }
    if (missingInfo) {
      logger.error("錯誤：收件人資料不全，無法完成兌換");
      throw new Error("收件人資料不全");
    }
     logger.log("收件人資料檢查完成");
  } catch (err) {
     logger.error(`檢查收件人資料時出錯: ${err.message}`);
     throw err;
  }
}

async function confirm(page, logger, recaptcha) {
  try {
    const agreeCheckbox = page.locator("input[name='agreeConfirm']");
    await agreeCheckbox.waitFor({ state: "attached", timeout: 15000 });
    if (!await agreeCheckbox.isChecked()) {
       logger.log("勾選同意條款");
       await agreeCheckbox.check({ force: true, timeout: 5000 });
    }

    await page.waitForTimeout(200 + Math.random()*300);
    const confirmButton1 = page.locator("a:has-text('確認兌換')");
    await confirmButton1.waitFor({ state: "visible", timeout: 10000 });
    await confirmButton1.click({ timeout: 10000 });

    const confirmDialogButton = page.locator(".popup-msg .btn-primary:has-text('確定')");
    await confirmDialogButton.waitFor({ state: "visible", timeout: 10000 });
    await confirmDialogButton.click({ timeout: 5000 });

    await page.waitForTimeout(700 + Math.random()*500);

    let solveAttempted = false;
    try {
        const recaptchaIframe = page.frameLocator("iframe[src*='recaptcha/api2/anchor']");
        await recaptchaIframe.locator("#recaptcha-anchor").waitFor({ state: 'visible', timeout: 5000}); // Check if anchor exists

        if (recaptcha.process === true) {
             logger.log("偵測到需要處理 reCAPTCHA (基於 response)");
             try {
                 await timeout_promise(solve(page, { delay: 64 }), 120000); // Increased timeout
                 solveAttempted = true;
                 logger.log("reCAPTCHA 自動處理嘗試完成");
             } catch (solveError) {
                 if (solveError instanceof NotFoundError) {
                     logger.error("reCAPTCHA [Solver NotFound]");
                 } else if (solveError.message && solveError.message.includes('timed out')) {
                     logger.error("reCAPTCHA 處理超時");
                 } else {
                     logger.error(`reCAPTCHA 處理時發生錯誤: ${solveError.message}`);
                 }
                 throw solveError; // Re-throw to signal failure in this attempt
             }
        } else {
             logger.log("檢查認為不需要處理 reCAPTCHA (基於 response)，但 reCAPTCHA 框存在");
             await page.waitForTimeout(1000);
        }

    } catch (anchorError) {
         if (anchorError.message && anchorError.message.includes('Timeout')) {
            logger.log("未找到 reCAPTCHA anchor 元素，假設無需處理");
         } else {
             logger.warn(`檢查 reCAPTCHA anchor 時出錯: ${anchorError.message}`);
         }
    }

    logger.log(`等待最終頁面加載 ${solveAttempted ? '(reCAPTCHA 已嘗試處理)' : ''}...`);
    await page.waitForLoadState('networkidle', { timeout: 60000 });

  } catch (err) {
    logger.error(`確認兌換過程中出錯: ${err.message}. URL: ${page.url()}`);
     if (page && !page.isClosed()) {
       await page.screenshot({ path: `error_confirm_process_${Date.now()}.png` }).catch(e=>logger.error(`截圖失敗: ${e}`));
     }
    throw err;
  }
}


function report({ lottery, unfinished }) {
  let body = "# 福利社抽抽樂 \n\n";
  if (lottery > 0) {
    body += `✨✨✨ 獲得 **${lottery}** 個抽獎機會，價值 **${(lottery * 500).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}** 巴幣 ✨✨✨\n`;
  } else {
      body += "😕 本次未獲得任何抽獎機會。\n";
  }

  const unfinishedKeys = Object.keys(unfinished);
  if (unfinishedKeys.length === 0 && lottery > 0) {
    body += "🟢 所有找到的抽獎皆已完成\n";
  } else if (unfinishedKeys.length > 0) {
    body += `\n⚠️ **${unfinishedKeys.length}** 個抽獎未能自動完成：\n`;
    unfinishedKeys.forEach((key) => {
       body += `- ❌ ***[${key}](${unfinished[key]})***\n`;
    });
  } else {
      body += "ℹ️ 沒有發現抽獎或所有發現的都已完成。\n"
  }
  body += "\n";
  return body;
}

function timeout_promise(promise, delay) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`Promise timed out after ${delay} ms`)), delay);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
}

export {
  lottery_default as default
};