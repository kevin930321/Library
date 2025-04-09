import { NotFoundError, solve } from "recaptcha-solver";
import { Pool } from "@jacoblincool/puddle";
import { URLSearchParams, URL } from 'url'; // 引入 Node.js 內建的 URL 和 URLSearchParams

// +++ 輔助函數：獲取 CSRF Token (Playwright 版本) +++
async function getCsrfTokenPlaywright(page, logger) {
    try {
        logger.log("正在獲取 CSRF token...");
        const response = await page.request.get("https://fuli.gamer.com.tw/ajax/getCSRFToken.php");
        if (!response.ok()) {
            throw new Error(`獲取 CSRF token 失敗，狀態碼: ${response.status()}`);
        }
        const token = (await response.text()).trim();
        if (!token) {
            throw new Error("從回應中找不到 CSRF token");
        }
        logger.log("成功獲取 CSRF token");
        return token;
    } catch (error) {
        logger.error(`獲取 CSRF token 時發生錯誤: ${error.message}`);
        throw error; // 重新拋出錯誤，讓上層處理
    }
}

// +++ 輔助函數：發送 finish_ad POST 請求 (Playwright 版本) +++
async function sendFinishAdRequestPlaywright(page, csrfToken, snValue, logger) {
    try {
        logger.log(`正在發送 finish_ad 請求 (sn: ${snValue})...`);
        const response = await page.request.post("https://fuli.gamer.com.tw/ajax/finish_ad.php", {
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                "X-Requested-With": "XMLHttpRequest" // 模擬 AJAX 請求
            },
            data: `token=${encodeURIComponent(csrfToken)}&area=item&sn=${encodeURIComponent(snValue)}`
        });

        const responseText = await response.text();
        logger.log(`finish_ad POST 回應: ${responseText}`);

        if (!response.ok()) {
            throw new Error(`finish_ad 請求失敗，狀態碼: ${response.status()}, 回應: ${responseText}`);
        }

        // 可以根據實際回應內容判斷是否成功，這裡假設狀態碼 200 即成功
        // 例如: const responseData = JSON.parse(responseText); if (responseData.error) throw ...
        return true; // 表示請求成功發送且伺服器接受

    } catch (error) {
        logger.error(`發送 finish_ad 請求時發生錯誤: ${error.message}`);
        return false; // 表示失敗
    }
}

// +++ 輔助函數：回答問題 (Playwright 版本) +++
async function answerQuestionPlaywright(page, logger) {
    logger.info(`偵測到需要回答問題，正在嘗試回答...`);
    try {
        const csrfToken = await getCsrfTokenPlaywright(page, logger);
        const urlParams = new URLSearchParams(new URL(page.url()).search);
        const snValue = urlParams.get('sn');
        if (!snValue) throw new Error("無法從 URL 獲取 sn 以回答問題");

        // 使用 page.evaluate 在瀏覽器上下文中提取答案
        const answers = await page.evaluate(() => {
            const extractedAnswers = [];
            const questions = document.querySelectorAll('.fuli-option[data-question]');
            const questionNumbers = new Set();
            questions.forEach(question => {
                questionNumbers.add(question.getAttribute('data-question'));
            });

            questionNumbers.forEach(questionNumber => {
                // UserScript 邏輯是直接用第一個選項的 data-answer
                const firstOption = document.querySelector(`.fuli-option[data-question="${questionNumber}"]`);
                if (firstOption) {
                    extractedAnswers.push(firstOption.getAttribute('data-answer'));
                }
            });
            return extractedAnswers;
        });

        if (answers.length === 0) {
             throw new Error("無法提取問題的答案");
        }
        logger.log(`提取到的答案: ${answers.join(', ')}`);

        // 準備 FormData
        const formData = new URLSearchParams();
        formData.append('sn', snValue);
        formData.append('token', csrfToken);
        answers.forEach(answer => formData.append('answer[]', answer));

        // 發送 POST 請求
        const response = await page.request.post("https://fuli.gamer.com.tw/ajax/answer_question.php", {
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                "X-Requested-With": "XMLHttpRequest"
            },
            data: formData.toString()
        });

        const responseText = await response.text();
        logger.log(`answer_question POST 回應: ${responseText}`);
        if (!response.ok()) {
            throw new Error(`answer_question 請求失敗，狀態碼: ${response.status()}, 回應: ${responseText}`);
        }
        // 解析回應判斷是否成功
        const responseData = JSON.parse(responseText);
        if (responseData.error) {
             throw new Error(`回答問題失敗: ${responseData.error.message || responseText}`);
        }

        logger.info("問題回答成功！");
        return true;

    } catch (error) {
        logger.error(`回答問題時發生錯誤: ${error.message}`);
        return false;
    }
}


var lottery_default = {
  name: "福利社",
  description: "福利社抽獎",
  async run({ page, shared, params, logger }) {
    if (!shared.flags.logged)
      throw new Error("使用者未登入，無法抽獎");

    logger.log(`開始執行`);
    let lottery = 0;
    logger.log("正在尋找抽抽樂");
    const draws = await getList(page, logger); // 保持不變
    logger.log(`找到 ${draws.length} 個抽抽樂`);
    const unfinished = {};
    draws.forEach(({ name, link }, i) => {
      logger.log(`${i + 1}: ${name}`);
      unfinished[name] = link;
    });
    const PARRALLEL = +params.max_parallel || 1;
    const MAX_ATTEMPTS = +params.max_attempts || +shared.max_attempts || 20;
    // CHANGING_RETRY 不再需要
    // const CHANGING_RETRY = +params.changing_retry || +shared.changing_retry || 3;
    const context = page.context();
    const pool = new Pool(PARRALLEL);

    for (let i = 0; i < draws.length; i++) {
      pool.push(async () => {
        const idx = i;
        const { link, name } = draws[idx];
        const task_page = await context.newPage();
        const recaptcha = { process: false }; // reCAPTCHA 邏輯保持不變

        // reCAPTCHA 監聽器保持不變
        task_page.on("response", async (response) => {
          try {
             if (response.url().includes("recaptcha/api2/userverify")) {
                const text = (await response.text()).replace(")]}'\n", "");
                const data = JSON.parse(text);
                recaptcha.process = data[2] === 0; // [verification status?]
             }
             if (response.url().includes("recaptcha/api2/reload")) {
                const text = (await response.text()).replace(")]}'\n", "");
                const data = JSON.parse(text);
                 // Check if it's a challenge ('nocaptcha' means no challenge)
                recaptcha.process = data[5] !== "nocaptcha";
             }
          } catch (e) {
             // Ignore parsing errors for responses not related to recaptcha JSON
             if (response.request().resourceType() !== 'fetch' && response.request().resourceType() !== 'xhr') {
                 // console.debug("Non-XHR/fetch response, ignoring parse error:", e.message);
             } else {
                 logger.warn("Error processing response for reCAPTCHA:", e.message);
             }
          }
        });


        for (let attempts = 1; attempts <= MAX_ATTEMPTS; attempts++) {
          let success = false; // 標記本次嘗試是否成功
          try {
            await task_page.goto(link);
            await task_page.waitForSelector("#BH-master > .BH-lbox.fuli-pbox h1", { timeout: 20000 }); // 增加超時
            await task_page.waitForTimeout(500); // 等待頁面穩定

            // 檢查是否已完成 (按鈕禁用)
            if (await task_page.locator(".btn-base.c-accent-o.is-disable").count() > 0) {
              logger.log(`${name} 的廣告免費次數已用完 \u001b[92m✔\u001b[m`);
              delete unfinished[name];
              success = true; // 標記為成功，跳出嘗試循環
              break;
            }

            // 定位 "看廣告免費兌換" 按鈕
            const adButtonLocator = task_page.locator('a:has-text("看廣告免費兌換")');
            if (await adButtonLocator.count() === 0) {
                 // 檢查是否需要回答問題 (另一種按鈕)
                 const questionButtonLocator = task_page.locator('a[onclick^="showQuestion(1);"]');
                 if (await questionButtonLocator.count() > 0) {
                     logger.info(`${name} 需要先回答問題`);
                     // 嘗試回答問題
                     if (await answerQuestionPlaywright(task_page, logger)) {
                         logger.info("回答問題成功，重新載入頁面以繼續...");
                         await task_page.reload({ waitUntil: 'domcontentloaded' });
                         await task_page.waitForSelector("#BH-master > .BH-lbox.fuli-pbox h1", { timeout: 20000 });
                         await task_page.waitForTimeout(500);
                         // 重新檢查按鈕狀態
                          if (await task_page.locator(".btn-base.c-accent-o.is-disable").count() > 0) {
                               logger.log(`${name} 回答問題後發現次數已用完 \u001b[92m✔\u001b[m`);
                               delete unfinished[name];
                               success = true;
                               break;
                          }
                          if (await adButtonLocator.count() === 0) {
                               throw new Error("回答問題後仍然找不到 '看廣告免費兌換' 按鈕");
                          }
                     } else {
                         throw new Error("回答問題失敗，無法繼續");
                     }
                 } else {
                     logger.warn(`${name} 找不到 '看廣告免費兌換' 按鈕，也找不到問題按鈕。可能已結束或頁面結構改變。`);
                     if (attempts === MAX_ATTEMPTS) unfinished[name] = link;
                     break; // 跳出嘗試循環，處理下一個項目
                 }
            }

            logger.log(`[${idx + 1} / ${draws.length}] (${attempts}/${MAX_ATTEMPTS}) ${name} - 嘗試跳過廣告`);

            // --- 廣告跳過邏輯 ---
            // 1. 點擊 "看廣告免費兌換"
            await adButtonLocator.click();
            await task_page.waitForTimeout(500); // 等待可能的彈窗出現

            // --- 移除處理 "廣告能量補充中" 的邏輯 ---

            // 2. 檢查是否彈出問題 (點擊廣告按鈕後才彈出的情況)
            const questionPopup = task_page.locator(".dialogify .dialogify__body:has-text('勇者問答考驗')");
            if (await questionPopup.count() > 0) {
                 logger.info(`${name} 在點擊廣告按鈕後需要回答問題`);
                 // 處理方式同上，先假設點擊前會處理完，若有問題再調整
                 await task_page.locator("#dialogify_1 button:has-text('關閉')").click().catch(()=>{ logger.warn("嘗試關閉問題彈窗失敗"); }); // 嘗試關閉
                 throw new Error("點擊廣告按鈕後出現問題彈窗，流程需要調整或重新嘗試");
            }

            // 3. 處理初始廣告提示彈窗 (點擊 "確定")
            try {
                const confirmButton = task_page.locator(".dialogify button:has-text('確定')");
                // 稍微增加等待時間以應對網路延遲
                await confirmButton.waitFor({ state: 'visible', timeout: 7000 });
                logger.log("檢測到廣告提示彈窗，點擊 '確定'");
                await confirmButton.click();
                await task_page.waitForTimeout(300); // 等待彈窗關閉
            } catch (e) {
                logger.log("未檢測到或無需點擊廣告提示彈窗的 '確定' 按鈕");
                // 可能是看過了、直接跳轉，或者彈窗結構不同，繼續執行
            }

            // 4. 獲取 sn
            const currentUrl = task_page.url();
            const urlParams = new URLSearchParams(new URL(currentUrl).search);
            const snValue = urlParams.get('sn');
            if (!snValue) {
                logger.error(`無法從當前 URL (${currentUrl}) 獲取 sn`);
                throw new Error("無法獲取 sn，無法繼續跳過廣告");
            }
            logger.log(`取得 sn: ${snValue}`);

            // 5. 獲取 CSRF token
            const csrfToken = await getCsrfTokenPlaywright(task_page, logger);

            // 6. 發送 finish_ad POST 請求
            const finishAdSuccess = await sendFinishAdRequestPlaywright(task_page, csrfToken, snValue, logger);

            if (finishAdSuccess) {
                logger.log("成功發送 finish_ad 請求。");
                // 7. *再次*點擊 "看廣告免費兌換" 以觸發導航到兌換頁面
                logger.log("再次點擊 '看廣告免費兌換' 以進入兌換頁面...");
                await Promise.all([
                    // 等待導航完成或超時
                    task_page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(e => logger.warn("導航等待超時或無導航:", e.message)),
                    adButtonLocator.click() // 再次點擊同一按鈕
                ]);
                await task_page.waitForTimeout(1000); // 等待頁面可能跳轉或加載
            } else {
                logger.error("發送 finish_ad 請求失敗，無法完成跳過");
                throw new Error("finish_ad 請求失敗"); // 拋出錯誤，由外層循環重試
            }
            // --- 廣告跳過邏輯結束 ---

            const final_url = task_page.url();
            logger.log(`操作後 URL: ${final_url}`);

            // 檢查是否成功進入結算頁面
            if (final_url.includes("/buyD.php")) {
              logger.log(`成功進入結算頁面`);
              await checkInfo(task_page, logger); // 檢查收件資訊 (保持不變)
              await confirm(task_page, logger, recaptcha); // 確認兌換並處理 reCAPTCHA (保持不變)

              // 檢查最終結果頁面
              await task_page.waitForTimeout(500); // 等待頁面可能再次跳轉或更新
               if (task_page.url().includes("message_done.php")) {
                    const successMsg = task_page.locator(".card > .section > p:has-text('成功')");
                    if (await successMsg.count() > 0) {
                        logger.success(`已完成一次抽抽樂：${name} \u001b[92m✔\u001b[m`);
                        lottery++;
                        delete unfinished[name]; // 從未完成列表中移除
                        success = true; // 標記成功
                    } else {
                        const errorMsg = await task_page.locator(".card > .section > p").textContent().catch(() => "未知錯誤訊息");
                        logger.error(`結算頁面訊息非預期: "${errorMsg}"，可能兌換失敗 \u001b[91m✘\u001b[m`);
                        // 不標記 success，讓外層重試
                    }
               } else if (await task_page.locator(".card > .section > p:has-text('成功')").count() > 0) {
                   // 有些情況可能停留在 buyD 但顯示成功訊息
                   logger.success(`已完成一次抽抽樂 (buyD頁面訊息)：${name} \u001b[92m✔\u001b[m`);
                   lottery++;
                   delete unfinished[name];
                   success = true;
               }
                else {
                    logger.error(`結算後未跳轉至 message_done.php 且未找到成功訊息，當前 URL: ${task_page.url()} \u001b[91m✘\u001b[m`);
                    // 不標記 success
                }

            } else {
              logger.warn(`預期進入 buyD.php，但目前在: ${final_url}`);
              logger.error("未進入結算頁面，重試中 \u001b[91m✘\u001b[m");
              // 拋出錯誤讓外層重試
              throw new Error("跳過廣告後未成功導航至 buyD.php");
            }

          } catch (err) {
            logger.error(`[${name}] (${attempts}/${MAX_ATTEMPTS}) 處理時發生錯誤:`, err.message);
             // 可以在這裡添加截圖或保存 HTML 以便調試
             // await task_page.screenshot({ path: `error_${name}_${attempts}.png` });
            if (attempts === MAX_ATTEMPTS) {
                logger.error(`[${name}] 已達最大重試次數，標記為未完成`);
                // 確保未完成列表有記錄
                 if (!(name in unfinished) || unfinished[name] !== link) {
                     unfinished[name] = link;
                 }
            }
          } finally {
               if (success) {
                  break; // 如果成功，跳出重試循環
               }
               // 如果未成功且還有嘗試次數，循環會繼續
               if (attempts < MAX_ATTEMPTS && !success) {
                  await task_page.waitForTimeout(1500); // 重試前稍作等待
               }
          }
        } // End attempts loop

        await task_page.close(); // 關閉當前任務頁面
      }); // End pool.push
    } // End for loop iterating through draws

    await pool.go(); // 等待所有並行任務完成
    await page.waitForTimeout(2e3); // 最後等待
    logger.log(`執行完畢 ✨`);
    if (shared.report) {
      shared.report.reports["福利社抽獎"] = report({ lottery, unfinished }); // 報告 (保持不變)
    }
    return { lottery, unfinished };
  } // End run function
};

// getList, checkInfo, confirm, report, timeout_promise 函數保持不變
async function getList(page, logger) {
  let draws = [];
  await page.context().addCookies([{ name: "ckFuli_18UP", value: "1", domain: "fuli.gamer.com.tw", path: "/" }]);
  let attempts = 3;
  while (attempts-- > 0) {
    draws = [];
    let currentPage = 1;
    try {
       logger.log(`正在獲取第 ${currentPage} 頁的抽抽樂列表...`);
       await page.goto(`https://fuli.gamer.com.tw/shop.php?page=${currentPage}`, { timeout: 20000, waitUntil: 'domcontentloaded' });
       await page.waitForSelector('.items-list', { timeout: 15000 }); // 等待列表容器

      while (true) {
         const items = await page.$$("a.items-card");
         logger.log(`第 ${currentPage} 頁找到 ${items.length} 個項目`);
         for (const item of items) {
             const is_draw = await item.evaluate(elm => elm.textContent.includes("抽抽樂"));
             if (is_draw) {
                  const itemName = await item.evaluate(node => node.querySelector(".items-title")?.innerText || "未知名稱");
                  const itemLink = await item.evaluate(elm => elm.href);
                  // 檢查連結是否包含 fuli.gamer.com.tw，避免無效連結
                  if (itemLink && itemLink.includes("fuli.gamer.com.tw/shop_detail.php?sn=")) {
                     draws.push({ name: itemName, link: itemLink });
                  } else {
                     logger.warn(`發現抽抽樂項目 "${itemName}" 但連結無效或非預期: ${itemLink}`);
                  }
             }
         }

         // 檢查是否有下一頁
         const nextPageLink = page.locator('a.page-next:not(.is-disable)'); // 找非禁用的下一頁按鈕
         if (await nextPageLink.count() > 0) {
             currentPage++;
             logger.log(`前往第 ${currentPage} 頁...`);
              // 使用點擊下一頁按鈕，而不是直接跳轉 URL，可能更穩定
             await Promise.all([
                  page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => logger.warn("下一頁導航超時")),
                  nextPageLink.click()
             ]);
             await page.waitForSelector('.items-list', { timeout: 15000 }); // 等待新頁面列表加載
             await page.waitForTimeout(500); // 額外等待
         } else {
             logger.log("沒有更多頁面了");
             break; // 沒有下一頁了，退出循環
         }
      }
      logger.log(`共找到 ${draws.length} 個抽抽樂`);
      break; // 成功獲取列表，退出重試循環
    } catch (err) {
      logger.error(`獲取抽抽樂列表時出錯 (第 ${currentPage} 頁, 嘗試次數 ${3-attempts}/3):`, err);
      if (attempts === 0) {
           logger.error("多次嘗試獲取列表失敗");
           return []; // 返回空列表
      }
      await page.waitForTimeout(2000); // 等待後重試
    }
  }
  return draws;
}

async function checkInfo(page, logger) {
  try {
    await page.waitForSelector('#name', { timeout: 10000 }); // 等待表單元素加載
    const name = await page.$eval("#name", (elm) => elm.value);
    const tel = await page.$eval("#tel", (elm) => elm.value);
    const city = await page.$eval("[name=city]", (elm) => elm.value);
    const country = await page.$eval("[name=country]", (elm) => elm.value);
    const address = await page.$eval("#address", (elm) => elm.value);
    let hasWarning = false;
    if (!name) { logger.warn("警告：無收件人姓名"); hasWarning = true; }
    if (!tel) { logger.warn("警告：無收件人電話"); hasWarning = true; }
    if (!city) { logger.warn("警告：無收件人城市"); hasWarning = true; }
    if (!country) { logger.warn("警告：無收件人區域"); hasWarning = true; }
    if (!address) { logger.warn("警告：無收件人地址"); hasWarning = true; }
    if (hasWarning) {
      logger.warn("收件人資料不全，請檢查 https://user.gamer.com.tw/addr/addr_list.php");
      // 可以選擇是否要因此停止腳本
      // throw new Error("警告：收件人資料不全");
    } else {
        logger.log("收件人資料檢查完畢 (非空)");
    }
  } catch (err) {
    logger.error("檢查收件人資料時發生錯誤:", err);
    // 根據需要決定是否拋出錯誤
  }
}

async function confirm(page, logger, recaptcha) {
  try {
    // 1. 同意條款
    await page.waitForSelector("input[name='agreeConfirm']", { state: "attached", timeout:10000 });
    const agreeCheckbox = page.locator("input[name='agreeConfirm']");
    if (!await agreeCheckbox.isChecked()) {
        logger.log("勾選 '我已閱讀注意事項...'");
        // 使用點擊 label 的方式，有時更穩定
        await page.locator("label[for='agree-confirm']").click();
    }

    await page.waitForTimeout(200); // 短暫等待

    // 2. 點擊主要確認按鈕 (可能觸發彈窗)
    logger.log("點擊 '確認兌換' 按鈕");
    await page.locator("a:has-text('確認兌換')").click();

    // 3. 處理確認彈窗
    logger.log("等待並點擊彈窗中的 '確定' 按鈕");
     // 等待彈窗出現並點擊確定
    const confirmDialogButton = page.locator(".dialogify button:has-text('確定')");
    await confirmDialogButton.waitFor({ state: 'visible', timeout: 10000 });
    await confirmDialogButton.click();

    // --- reCAPTCHA 處理 ---
    await page.waitForTimeout(1000); // 等待 reCAPTCHA 可能的加載

    if (recaptcha.process === true) {
         logger.log("監聽到需要處理 reCAPTCHA 的網路請求");
         const recaptchaIframe = page.locator("iframe[src*='google.com/recaptcha/api2/bframe']");
         // 增加判斷 iframe 是否真的在 DOM 中且可見
         if (await recaptchaIframe.count() > 0 && await recaptchaIframe.isVisible()) {
             logger.log("reCAPTCHA iframe 可見，嘗試自動處理...");
             try {
                 await timeout_promise(solve(page, { delay: 64 }), 60000); // 增加超時到 60 秒
                 logger.log("reCAPTCHA 自動處理請求已發送 (不保證成功)");
                 await page.waitForTimeout(2000); // 求解後等待
             } catch (err) {
                 if (err instanceof NotFoundError) {
                     logger.error("reCAPTCHA 求解器未找到驗證元素 [可能需要稍後重試或手動處理]");
                 } else if (err === 'Timed Out') {
                     logger.error("reCAPTCHA 求解超時");
                 }
                 else {
                     logger.error("reCAPTCHA 處理時發生未知錯誤:", err);
                 }
                 // 即使失敗也繼續
             }
         } else {
              logger.log("監聽到 reCAPTCHA 請求，但 iframe 不可見或不存在，可能無需處理");
         }
    } else {
         logger.log("未監聽到需要處理 reCAPTCHA 的網路請求，或為非挑戰型驗證");
    }

    // --- 等待最終導航 ---
    logger.log("等待最終頁面導航...");
    try {
         await page.waitForURL(/message_done\.php/, { timeout: 20000, waitUntil: 'domcontentloaded' });
         logger.log("已導航至最終結果頁面");
    } catch (e) {
         logger.warn(`等待導航至 message_done.php 超時或失敗，當前 URL: ${page.url()}. 可能已在 buyD 頁面顯示結果，或流程失敗。`);
    }

  } catch (err) {
    logger.error(`確認兌換過程中發生錯誤 (URL: ${page.url()}):`, err);
    // await page.screenshot({ path: `error_confirm_${Date.now()}.png` });
    throw err; // 將錯誤向上拋出
  }
}

function report({ lottery, unfinished }) {
  let body = "# 福利社抽抽樂 (廣告跳過版) \n\n"; // 修改標題
  if (lottery > 0) { // 只有大於 0 才顯示
    body += `✨✨✨ 成功兌換 **${lottery}** 個抽獎機會 ✨✨✨\n`;
  } else {
     body += `ℹ️ 本次運行未能成功兌換任何抽獎機會。\n`;
  }

  const unfinishedKeys = Object.keys(unfinished).filter(key => unfinished[key] !== undefined); // 過濾掉值為 undefined 的鍵

  if (unfinishedKeys.length === 0 && lottery > 0) {
    body += "🟢 所有找到的抽抽樂皆已完成兌換！\n";
  } else if (unfinishedKeys.length > 0) {
     body += `\n⚠️ 以下抽抽樂未能自動完成兌換：\n`;
     unfinishedKeys.forEach((key) => {
       body += `- [ ] ***[${key}](${unfinished[key]})***\n`; // 使用 markdown 待辦事項格式
     });
     body += "\n請檢查日誌或手動嘗試。\n";
  } else if (lottery === 0 && unfinishedKeys.length === 0) { // 確保這條件的精確性
     // 沒有成功也沒有失敗的，可能是沒找到抽獎或列表獲取失敗
     body += "未發現需要處理或未能完成的抽抽樂 (或者列表獲取失敗)。\n";
  }

  body += "\n";
  return body;
}

function timeout_promise(promise, delay) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject("Timed Out"), delay);
    promise.then(resolve).catch(reject).finally(() => clearTimeout(timer));
  });
}

export {
  lottery_default as default
};
