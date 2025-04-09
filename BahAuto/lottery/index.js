import { NotFoundError, solve } from "recaptcha-solver";
import { Pool } from "@jacoblincool/puddle";

// Helper function to get CSRF token using Playwright page context
async function getCsrfToken(page, logger) {
    logger.log("正在獲取 CSRF token...");
    try {
        const response = await page.request.get("https://fuli.gamer.com.tw/ajax/getCSRFToken.php", {
            headers: {
                'X-Requested-With': 'XMLHttpRequest' // Mimic AJAX request
            }
        });
        if (!response.ok()) {
            throw new Error(`獲取 CSRF token 失敗: ${response.status()} ${response.statusText()}`);
        }
        const token = (await response.text()).trim();
        if (!token) {
            throw new Error("獲取到的 CSRF token 為空");
        }
        logger.log("成功獲取 CSRF token");
        return token;
    } catch (error) {
        logger.error('獲取 CSRF token 時發生錯誤:', error);
        throw error; // Re-throw to be caught by the main loop
    }
}

// Helper function to send the finish_ad request
async function sendFinishAdRequest(page, logger, csrfToken, snValue) {
    logger.log(`正在為 sn=${snValue} 發送 finish_ad 請求...`);
    try {
        const response = await page.request.post("https://fuli.gamer.com.tw/ajax/finish_ad.php", {
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                "X-Requested-With": "XMLHttpRequest"
            },
            data: `token=${encodeURIComponent(csrfToken)}&area=item&sn=${encodeURIComponent(snValue)}`
        });

        if (!response.ok()) {
             throw new Error(`發送 finish_ad 請求失敗: ${response.status()} ${response.statusText()}`);
        }
        const responseBody = await response.json().catch(e => {
            logger.warn('解析 finish_ad 回應 JSON 失敗:', e, '原始回應:', response.text());
            return { error: 'json parse failed' }; // Return an object indicating failure
        });
        logger.log('finish_ad POST 回應:', responseBody);

        // You might want to check responseBody for specific success indicators if available
        if (responseBody.error && responseBody.error !== 0) {
             throw new Error(`finish_ad 請求返回錯誤: ${JSON.stringify(responseBody)}`);
        }

        logger.log("成功發送 finish_ad 請求");
        return true; // Indicate success
    } catch (error) {
        logger.error('發送 finish_ad 請求時發生錯誤:', error);
        throw error; // Re-throw to be caught by the main loop
    }
}


var lottery_default = {
    name: "福利社",
    description: "福利社抽獎 (廣告跳過版)",
    async run({ page, shared, params, logger }) {
        if (!shared.flags.logged)
            throw new Error("使用者未登入，無法抽獎");
        // if (!shared.ad_handler) // No longer needed
        //     throw new Error("需使用 ad_handler 模組");
        logger.log(`開始執行 (廣告跳過模式)`);
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

                // Setup reCAPTCHA detection (no changes needed here)
                task_page.on("response", async (response) => {
                    if (response.url().includes("recaptcha/api2/userverify")) {
                        try {
                            const text = (await response.text()).replace(")]}'\n", "");
                            const data = JSON.parse(text);
                            recaptcha.process = data[2] === 0;
                        } catch (e) { logger.warn("無法解析 userverify 回應", e); }
                    }
                    if (response.url().includes("recaptcha/api2/reload")) {
                         try {
                            const text = (await response.text()).replace(")]}'\n", "");
                            const data = JSON.parse(text);
                            recaptcha.process = data[5] !== "nocaptcha";
                         } catch (e) { logger.warn("無法解析 reload 回應", e); }
                    }
                });

                for (let attempts = 1; attempts <= MAX_ATTEMPTS; attempts++) {
                    let success = false; // Flag to break attempt loop on success
                    try {
                        logger.log(`[${idx + 1} / ${draws.length}] (${attempts}/${MAX_ATTEMPTS}) 前往: ${name}`);
                        await task_page.goto(link, { waitUntil: 'domcontentloaded', timeout: 30000 });
                        await task_page.waitForSelector("#BH-master > .BH-lbox.fuli-pbox h1", { timeout: 15000 });
                        await task_page.waitForTimeout(500); // Brief pause for dynamic content

                        // Check if already used up
                        if (await task_page.locator(".btn-base.c-accent-o.is-disable").isVisible({timeout: 2000}).catch(() => false)) {
                            logger.log(`${name} 的廣告免費次數已用完 \u001b[92m✔\u001b[m`);
                            delete unfinished[name];
                            success = true; // Mark as "successful" for this item (no more attempts needed)
                            break; // Exit attempt loop
                        }

                        // --- Check for Questions ---
                        if (await task_page.locator('a[onclick^="showQuestion(1);"]').isVisible({timeout: 2000}).catch(() => false)) {
                           logger.info(`[${name}] 需要回答問題，正在處理...`);
                           try {
                                const csrfToken = await getCsrfToken(task_page, logger);
                                const urlParams = new URLSearchParams(new URL(task_page.url()).search);
                                const snValue = urlParams.get('sn');
                                if (!snValue) throw new Error("無法從 URL 獲取 sn 以回答問題");

                                // Extract answers (assuming the structure is consistent)
                                const answers = await task_page.evaluate(() => {
                                    const qAnswers = [];
                                    const questions = document.querySelectorAll('#question-popup .fuli-option[data-question]');
                                    const questionNumbers = new Set();
                                    questions.forEach(q => questionNumbers.add(q.getAttribute('data-question')));
                                    questionNumbers.forEach(qNum => {
                                        const correctOption = document.querySelector(`#question-popup .fuli-option[data-question="${qNum}"][data-answer]`);
                                        if (correctOption) {
                                            qAnswers.push(correctOption.getAttribute('data-answer'));
                                        } else {
                                            // Fallback or error handling if structure changes
                                            console.warn(`找不到問題 ${qNum} 的答案選項`);
                                        }
                                    });
                                    return qAnswers;
                                });

                                if (answers.length === 0) {
                                     throw new Error("無法提取問題答案");
                                }

                                // Send answers
                                const answerResponse = await task_page.request.post('https://fuli.gamer.com.tw/ajax/answer_question.php', {
                                    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' },
                                    data: `sn=${encodeURIComponent(snValue)}&token=${encodeURIComponent(csrfToken)}&${answers.map(a => `answer[]=${encodeURIComponent(a)}`).join('&')}`
                                });
                                const answerJson = await answerResponse.json().catch(() => ({}));
                                logger.log("回答問題回應:", answerJson);
                                if (!answerResponse.ok() || (answerJson.error && answerJson.error !== 0)) {
                                     throw new Error(`回答問題請求失敗: ${JSON.stringify(answerJson)}`);
                                }
                                logger.info(`[${name}] 問題回答完畢，重新載入頁面...`);
                                await task_page.reload({ waitUntil: 'domcontentloaded' });
                                await task_page.waitForTimeout(1000); // Wait after reload
                                // Continue to the ad skip logic in the same attempt
                           } catch(questionError) {
                                logger.error(`[${name}] 處理問題時發生錯誤:`, questionError);
                                continue; // Try next attempt
                           }
                        }
                        // --- End Question Check ---


                        // Locate the button
                         const adButtonLocator = task_page.locator("text=看廣告免費兌換");
                         if (!(await adButtonLocator.isVisible({timeout: 5000}).catch(() => false))) {
                             logger.warn(`[${name}] 找不到 "看廣告免費兌換" 按鈕，可能已兌換或頁面結構變更。`);
                             // Might already be done or encountered an issue, try next attempt or assume finished if URL changes
                             if (task_page.url().includes("/buyD.php")) {
                                logger.log(`[${name}] 已在 buyD 頁面，嘗試確認。`);
                                // Proceed to confirmation logic directly
                             } else {
                                 continue; // Try next attempt
                             }
                         } else {
                             logger.log(`[${idx + 1} / ${draws.length}] (${attempts}) 點擊 "看廣告免費兌換": ${name}`);
                             await adButtonLocator.click();
                         }


                        // --- Handle Dialog (Charging / Watch Ad Prompt) ---
                        let dialogText = "";
                        let isCharging = false;
                        try {
                            await task_page.waitForSelector(".dialogify .dialogify__body p", { timeout: 7000 });
                            dialogText = await task_page.locator(".dialogify .dialogify__body p").innerText({ timeout: 5000 });
                            logger.log(`彈窗內容: "${dialogText}"`);

                            if (dialogText.includes("廣告能量補充中")) {
                                isCharging = true;
                                logger.info(`[${name}] 廣告能量補充中，關閉彈窗並重試。`);
                                await task_page.locator("button:has-text('關閉')").click({ timeout: 3000 });
                                // Maybe add a longer delay before next attempt if charging?
                                await task_page.waitForTimeout(5000); // Wait a bit before reload/retry
                                continue; // Go to next attempt
                            }

                            if (dialogText.includes("觀看廣告")) {
                                logger.log(`[${name}] 偵測到觀看廣告提示，開始執行跳過流程...`);

                                // --- Start Ad Skip Logic ---
                                const currentUrl = task_page.url();
                                const urlParams = new URLSearchParams(new URL(currentUrl).search);
                                const snValue = urlParams.get('sn');
                                if (!snValue) {
                                    throw new Error("無法從 URL 中獲取 sn");
                                }

                                const csrfToken = await getCsrfToken(task_page, logger);
                                await sendFinishAdRequest(task_page, logger, csrfToken, snValue);

                                // Now click the "確定" button in the dialog
                                logger.log(`[${name}] 跳過請求已發送，點擊 "確定" 按鈕以繼續...`);
                                const confirmButton = task_page.locator(".dialogify button:has-text('確定')");
                                if (!(await confirmButton.isVisible({timeout: 3000}))) {
                                    throw new Error("無法找到 '確定' 按鈕以繼續跳過流程");
                                }

                                await Promise.all([
                                    task_page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(e => logger.warn("廣告跳過後等待導航超時，可能已在目標頁面:", e)),
                                    confirmButton.click()
                                ]);
                                logger.log(`[${name}] "確定" 按鈕已點擊，等待頁面跳轉...`);
                                // --- End Ad Skip Logic ---

                            } else if (dialogText) {
                                // Unexpected dialog
                                logger.warn(`[${name}] 未預期的彈窗內容: "${dialogText}"，嘗試關閉並重試。`);
                                await task_page.locator("button:has-text('關閉'), button:has-text('確定')").first().click({ timeout: 3000 }).catch(() => {});
                                continue; // Go to next attempt
                            } else {
                                // No dialog text found, maybe page structure changed or it navigated directly?
                                logger.warn(`[${name}] 未偵測到彈窗文字，檢查當前 URL...`);
                            }

                        } catch (dialogError) {
                             if (dialogError.message.includes('Timeout') && !isCharging) {
                                logger.warn(`[${name}] 等待彈窗超時，可能已直接跳轉或發生錯誤。檢查 URL...`);
                                // Proceed to check URL anyway
                             } else if (!isCharging){
                                logger.error(`[${name}] 處理彈窗時發生錯誤:`, dialogError);
                                continue; // Go to next attempt
                             }
                             // If it was charging, the 'continue' was already called
                        }
                        // --- End Dialog Handling ---


                        // --- Confirmation Page Logic ---
                        await task_page.waitForTimeout(1000); // Small delay to ensure navigation settles
                        const final_url = task_page.url();
                        logger.log(`[${name}] 當前 URL: ${final_url}`);

                        if (final_url.includes("/buyD.php")) {
                            logger.log(`[${name}] 進入結算頁面，正在確認...`);
                            await checkInfo(task_page, logger).catch(
                                (err) => logger.error(`[${name}] 檢查收件資訊時出錯:`, err) // Log error but continue to confirm
                            );
                            await confirm(task_page, logger, recaptcha).catch(
                                (err) => {
                                    logger.error(`[${name}] 確認兌換時出錯:`, err);
                                    throw err; // Re-throw to signal failure for this attempt
                                }
                            );

                            // Check for success message
                            await task_page.waitForTimeout(500); // Wait for potential success message to appear
                            const successMsgLocator = task_page.locator(".card > .section > p, .message_area-text > h1"); // Look for common success message containers
                            let isSuccess = false;
                            if (await successMsgLocator.isVisible({timeout: 5000}).catch(() => false)) {
                               const successText = await successMsgLocator.innerText({timeout: 3000});
                               if (successText.includes("成功")) {
                                    logger.success(`[${name}] 已成功完成一次抽抽樂 \u001b[92m✔\u001b[m`);
                                    lottery++;
                                    isSuccess = true;
                               } else {
                                   logger.error(`[${name}] 在確認頁面但未找到成功訊息，訊息: "${successText}" \u001b[91m✘\u001b[m`);
                               }
                            } else {
                                logger.error(`[${name}] 未找到成功/失敗訊息元素，可能兌換失敗 \u001b[91m✘\u001b[m`);
                            }


                            if(isSuccess) {
                                delete unfinished[name];
                                success = true; // Mark as successful
                            }
                            // Navigate away or close page to prevent accidental re-submission if needed
                            // For simplicity, we just break the loop here if successful. The page will be closed later.

                        } else {
                            logger.error(`[${name}] 未能進入結算頁面 (buyD.php)，仍在 ${final_url}。重試中... \u001b[91m✘\u001b[m`);
                            // Let the loop continue for the next attempt
                        }

                    } catch (err) {
                        logger.error(`[${name}] 第 ${attempts} 次嘗試時發生未預期錯誤:`, err);
                        // Don't break, allow retry attempts
                    } finally {
                        if (success) {
                            break; // Exit the attempt loop if successfully processed
                        }
                        if (attempts >= MAX_ATTEMPTS && !success) {
                           logger.error(`[${name}] 已達最大嘗試次數 (${MAX_ATTEMPTS})，放棄。`);
                           // Keep it in unfinished list
                        }
                    }
                } // End attempts loop

                await task_page.close().catch(e => logger.warn(`關閉頁面 ${name} 時出錯:`, e));
            }); // End pool.push
        } // End for loop

        await pool.go();
        await page.waitForTimeout(2000); // Final wait
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
        try {
            logger.log(`獲取列表第 ${3 - attempts} 次嘗試...`);
            await page.goto("https://fuli.gamer.com.tw/shop.php?page=1", { waitUntil: 'domcontentloaded', timeout: 30000 });

            async function scrapePage() {
                const items = await page.locator("a.items-card").all();
                 logger.log(`當前頁面找到 ${items.length} 個項目`);
                for (const item of items) {
                    const html = await item.innerHTML().catch(() => "");
                    if (html.includes("抽抽樂")) {
                        const name = await item.locator(".items-title").innerText().catch(() => "未知名稱");
                        const link = await item.getAttribute("href").catch(() => "");
                        if (link) {
                            draws.push({ name: name.trim(), link: `https://fuli.gamer.com.tw/${link}` });
                        }
                    }
                }
            }

            await scrapePage();

            while (true) {
                const nextPageLink = page.locator("a.pagenow + a[href*='shop.php?page=']"); // More specific selector for next page link
                if (!(await nextPageLink.isVisible({timeout: 1000}).catch(() => false))) {
                    logger.log("沒有下一頁了");
                    break; // No more pages
                }
                const nextPageNum = await nextPageLink.innerText();
                logger.log(`前往第 ${nextPageNum} 頁...`);
                await nextPageLink.click();
                await page.waitForURL(/shop\.php\?page=\d+/, { waitUntil: 'domcontentloaded', timeout: 20000 });
                await page.waitForTimeout(500); // Wait for content load
                await scrapePage();
            }

            logger.log(`列表獲取完成，共 ${draws.length} 個抽抽樂。`);
            break; // Success
        } catch (err) {
            logger.error(`獲取列表失敗 (嘗試 ${3 - attempts}):`, err);
            if (attempts <= 0) {
                logger.error("無法獲取抽抽樂列表，放棄。");
                return []; // Return empty array on failure
            }
            await page.waitForTimeout(3000); // Wait before retry
        }
    }
    return draws;
}

async function checkInfo(page, logger) {
    logger.log("檢查收件人資訊...");
    let infoComplete = true;
    try {
        // Use locators for better reliability
        const name = await page.locator("#name").inputValue({ timeout: 5000 });
        const tel = await page.locator("#tel").inputValue({ timeout: 5000 });
        const city = await page.locator("[name=city]").inputValue({ timeout: 5000 });
        const country = await page.locator("[name=country]").inputValue({ timeout: 5000 });
        const address = await page.locator("#address").inputValue({ timeout: 5000 });

        if (!name) { logger.warn("缺少收件人姓名"); infoComplete = false; }
        if (!tel) { logger.warn("缺少收件人電話"); infoComplete = false; }
        if (!city) { logger.warn("缺少收件人城市"); infoComplete = false; }
        if (!country) { logger.warn("缺少收件人區域"); infoComplete = false; }
        if (!address) { logger.warn("缺少收件人地址"); infoComplete = false; }

        if (!infoComplete) {
            logger.error("警告：收件人資料不完整！請前往福利社手動填寫並勾選 '記住資料'。");
            // Consider throwing an error here if incomplete info should stop the process
            // throw new Error("收件人資料不完整");
        } else {
            logger.log("收件人資訊似乎完整。");
        }
    } catch (err) {
        // Log error but don't necessarily stop, confirmation might still work if info is saved server-side
        logger.error("檢查收件人資訊時發生錯誤 (可能元素未找到):", err);
    }
}

async function confirm(page, logger, recaptcha) {
    logger.log("開始確認兌換流程...");
    try {
        // 1. Check and click agreement checkbox
        const agreeCheckbox = page.locator("input[name='agreeConfirm']");
        await agreeCheckbox.waitFor({ state: "attached", timeout: 10000 });
        if (!(await agreeCheckbox.isChecked())) {
            logger.log("勾選同意條款...");
            await agreeCheckbox.click();
            await page.waitForTimeout(200); // Small delay after click
        } else {
             logger.log("同意條款已勾選。");
        }

        // 2. Click the main confirmation button (often triggers a dialog)
        const confirmButton1 = page.locator("a:has-text('確認兌換')");
        await confirmButton1.waitFor({ state: "visible", timeout: 10000 });
        logger.log("點擊 '確認兌換' 按鈕...");
        await confirmButton1.click();

        // 3. Handle the confirmation dialog
        const dialogConfirmButton = page.locator(".dialogify button:has-text('確定')");
        await dialogConfirmButton.waitFor({ state: "visible", timeout: 10000 });
        logger.log("點擊彈窗中的 '確定' 按鈕...");

        // Capture navigation promise *before* clicking the button that triggers it
        const navigationPromise = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => {
             logger.warn("確認兌換後等待導航超時或失敗，繼續處理:", e);
             return null; // Allow proceeding even if navigation fails/times out
        });

        await dialogConfirmButton.click();

        // 4. Handle reCAPTCHA if it appears (logic depends on recaptcha.process flag)
        await page.waitForTimeout(1000); // Wait a bit for potential CAPTCHA to load

        if (recaptcha.process === true) {
             logger.log("檢測到 reCAPTCHA 可能需要處理...");
             // Check if the CAPTCHA challenge is actually visible
             const recaptchaIframe = page.frameLocator('iframe[src*="api2/bframe"]');
             const checkbox = recaptchaIframe.locator('#recaptcha-anchor'); // The checkbox element

             if (await checkbox.isVisible({timeout: 5000}).catch(() => false)) {
                  // Additional check for visible challenge (sometimes it's just the logo)
                  const challenge = page.locator('iframe[src*="api2/cframe"]'); // Challenge iframe selector might vary
                  if (await challenge.isVisible({timeout: 3000}).catch(() => false) || recaptcha.process) { // Double check with the flag
                      logger.log("reCAPTCHA 挑戰可見，嘗試自動處理...");
                      try {
                          // Use a timeout for the solver
                          await timeout_promise(solve(page, { delay: 64 }), 60000); // 60 second timeout for solver
                          logger.log("reCAPTCHA 自動處理完成");
                          // Wait a bit more for submission after solve
                          await page.waitForTimeout(2000);
                      } catch (err) {
                          if (err instanceof NotFoundError || err === 'Timed Out') {
                              logger.error(`reCAPTCHA 處理失敗: ${err}`);
                          }
                          // Re-throw to indicate confirmation failure
                          throw new Error(`reCAPTCHA 處理失敗: ${err}`);
                      }
                  } else {
                      logger.log("reCAPTCHA 存在但未顯示挑戰，可能已自動驗證。");
                  }
             } else {
                  logger.log("reCAPTCHA 元素未找到或不可見，跳過處理。");
             }
        } else {
             logger.log("未檢測到需要處理的 reCAPTCHA。");
        }

        // 5. Wait for the navigation triggered by the dialog confirmation to complete
        logger.log("等待最終頁面加載...");
        await navigationPromise;
        await page.waitForTimeout(500); // Final short pause
        logger.log("確認兌換流程結束。");

    } catch (err) {
        logger.error("確認兌換過程中發生錯誤:", err);
        logger.error("錯誤發生時的 URL:", page.url());
        throw err; // Re-throw the error to signal failure
    }
}

function report({ lottery, unfinished }) {
    let body = "# 福利社抽獎 (廣告跳過模式) \n\n";
    if (lottery > 0) {
        body += `✨✨✨ 成功跳過廣告並完成 **${lottery}** 次抽獎機會兌換 ✨✨✨\n`;
        // body += `價值 **${(lottery * 500).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}** 巴幣\n`; // Optional value text
    } else {
        body += `未能成功兌換任何抽獎機會。\n`;
    }

    const unfinishedKeys = Object.keys(unfinished);
    if (unfinishedKeys.length === 0) {
        body += "\n🟢 所有找到的抽抽樂均已處理完成。\n";
    } else {
        body += `\n🔴 以下 ${unfinishedKeys.length} 個抽抽樂未能成功完成兌換:\n`;
        unfinishedKeys.forEach((key) => {
            if (unfinished[key]) { // Check if link exists
                 body += `- [${key}](${unfinished[key]})\n`;
            } else {
                 body += `- ${key} (連結遺失)\n`;
            }
        });
         body += "請檢查 Log 或手動嘗試。\n";
    }
    body += "\n";
    return body;
}

// Timeout Promise Helper
function timeout_promise(promise, delay) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Timed Out")), delay);
        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (error) => {
                clearTimeout(timer);
                reject(error);
            }
        );
    });
}

export {
    lottery_default as default
};
