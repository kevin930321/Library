import { utils } from "bahamut-automation";
const { goto } = utils;
var sign_default = {
  name: "\u7C3D\u5230",
  description: "\u7C3D\u5230\u6A21\u7D44",
  async run({ page, shared, params, logger }) {
    if (!shared.flags.logged)
      throw new Error("\u4F7F\u7528\u8005\u672A\u767B\u5165\uFF0C\u7121\u6CD5\u7C3D\u5230");
    logger.log(`\u958B\u59CB\u57F7\u884C`);
    await goto(page, "home");
    await page.waitForTimeout(2e3);
    
    // 使用網站內建 API 檢查簽到狀態
    let { days, finishedAd, signin } = await sign_status(page);
    logger.info(`\u5DF2\u9023\u7E8C\u7C3D\u5230\u5929\u6578: ${days}`);
    
    // 簽到邏輯
    if (!signin) {
      logger.warn("\u4ECA\u65E5\u5C1A\u672A\u7C3D\u5230 \x1B[91m\u2718\x1B[m");
      logger.log("\u6B63\u5728\u5617\u8A66\u7C3D\u5230");
      
      // 使用網站內建 API 執行簽到
      const signResult = await page.evaluate(async () => {
        try {
          if (typeof window.Signin !== 'undefined' && typeof window.Signin.signinWork === 'function') {
            await window.Signin.signinWork();
            return { success: true, method: 'signinWork' };
          } else if (typeof window.Signin !== 'undefined' && typeof window.Signin.mobile === 'function') {
            window.Signin.mobile();
            return { success: true, method: 'mobile' };
          }
          return { success: false, method: 'none' };
        } catch (e) {
          return { success: false, error: e.message };
        }
      });
      
      if (signResult.success) {
        logger.success(`\u6210\u529F\u7C3D\u5230 (\u4F7F\u7528 ${signResult.method}) \x1B[92m\u2714\x1B[m`);
      } else {
        // 備用方案：使用按鈕點擊
        logger.log("\u5617\u8A66\u4F7F\u7528\u5099\u7528\u65B9\u6848\u7C3D\u5230");
        await page.click("a#signin-btn").catch((err) => logger.error(err));
      }
      await page.waitForTimeout(3e3);
      
      // 重新檢查簽到狀態
      const newStatus = await sign_status(page);
      signin = newStatus.signin;
      finishedAd = newStatus.finishedAd;
      days = newStatus.days;
    } else {
      logger.info("\u4ECA\u65E5\u5DF2\u7C3D\u5230 \x1B[92m\u2714\x1B[m");
    }
    
    // 雙倍巴幣獎勵邏輯 - 使用網站內建 SigninAd API
    const max_attempts = +params.double_max_attempts || 3;
    if (!finishedAd) {
      logger.log("\u5C1A\u672A\u7372\u5F97\u96D9\u500D\u7C3D\u5230\u734E\u52F5 \x1B[91m\u2718\x1B[m");
      
      for (let attempts = 0; attempts < max_attempts; attempts++) {
        try {
          logger.log(`\u5617\u8A66\u7372\u53D6\u96D9\u500D\u5DF4\u5E63\u734E\u52F5 (\u5617\u8A66 ${attempts + 1}/${max_attempts})`);
          
          // 重新載入首頁確保狀態正確
          await goto(page, "home");
          await page.waitForTimeout(2e3);
          
          // 使用網站內建 API 初始化並播放廣告
          const adResult = await page.evaluate(() => {
            return new Promise((resolve) => {
              try {
                if (typeof window.SigninAd === 'undefined') {
                  resolve({ success: false, error: 'SigninAd not found' });
                  return;
                }
                
                // 覆寫 Dialogify.confirm 以自動確認觀看廣告
                if (typeof window.Dialogify !== 'undefined') {
                  const originalConfirm = window.Dialogify.confirm;
                  window.Dialogify.confirm = (message, options) => {
                    if (message === '是否觀看廣告？') {
                      // 自動確認觀看廣告
                      if (options && options.ok) {
                        options.ok();
                      }
                      return;
                    }
                    originalConfirm.call(window.Dialogify, message, options);
                  };
                }
                
                // 覆寫 Dialogify.alert 以監控廣告觀看狀態
                if (typeof window.Dialogify !== 'undefined') {
                  const originalAlert = window.Dialogify.alert;
                  window.Dialogify.alert = (message) => {
                    if (message.includes('觀看廣告完成')) {
                      resolve({ success: true, message: 'ad_complete' });
                    }
                    originalAlert.call(window.Dialogify, message);
                  };
                }
                
                // 覆寫 videoByReward 以處理廣告播放
                const originalVideoByReward = window.SigninAd.Player.videoByReward;
                window.SigninAd.Player.videoByReward = () => {
                  try {
                    originalVideoByReward.call(window.SigninAd.Player);
                  } catch (e) {
                    // 忽略錯誤
                  } finally {
                    // 關閉廣告載入中彈窗
                    const popup = document.querySelector('.dialogify__adsPopup');
                    if (popup && popup.close) {
                      popup.close();
                    }
                    // 延遲調用完成函數
                    setTimeout(() => {
                      if (typeof window.Signin.finishAd === 'undefined') {
                        window.Signin.finishAd = () => {
                          window.SigninAd.finishAd();
                        };
                      }
                      try {
                        window.SigninAd.setFinishAd();
                        resolve({ success: true, message: 'finish_ad_called' });
                      } catch (e) {
                        resolve({ success: false, error: e.message });
                      }
                    }, 1500);
                  }
                };
                
                // 覆寫廣告載入失敗處理
                window.SigninAd.loadingFail = () => {};
                
                // 初始化並開始廣告
                try {
                  window.SigninAd.initAd();
                } catch (e) {
                  // ADBlock 可能會導致異常
                }
                
                setTimeout(() => {
                  try {
                    window.SigninAd.startAd();
                  } catch (e) {
                    resolve({ success: false, error: 'startAd failed: ' + e.message });
                  }
                }, 1000);
                
                // 設定超時
                setTimeout(() => {
                  resolve({ success: false, error: 'timeout' });
                }, 30000);
                
              } catch (e) {
                resolve({ success: false, error: e.message });
              }
            });
          });
          
          logger.log(`\u5EE3\u544A\u8655\u7406\u7D50\u679C: ${JSON.stringify(adResult)}`);
          
          // 等待一段時間讓廣告處理完成
          await page.waitForTimeout(5e3);
          
          // 檢查是否成功獲得雙倍獎勵
          const statusAfterAd = await sign_status(page);
          if (statusAfterAd.finishedAd) {
            finishedAd = true;
            logger.success("\u5DF2\u7372\u5F97\u96D9\u500D\u7C3D\u5230\u734E\u52F5 \x1B[92m\u2714\x1B[m");
            break;
          }
          
          if (adResult.success) {
            // 再等待一下確認狀態
            await page.waitForTimeout(3e3);
            const finalCheck = await sign_status(page);
            if (finalCheck.finishedAd) {
              finishedAd = true;
              logger.success("\u5DF2\u7372\u5F97\u96D9\u500D\u7C3D\u5230\u734E\u52F5 \x1B[92m\u2714\x1B[m");
              break;
            }
          }
          
          logger.warn(`\u5617\u8A66 ${attempts + 1} \u5931\u6557\uFF0C\u5C07\u91CD\u8A66`);
          
        } catch (err) {
          logger.error(err);
          logger.error(
            `\u89C0\u770B\u96D9\u500D\u734E\u52F5\u5EE3\u544A\u904E\u7A0B\u767C\u751F\u932F\u8AA4\uFF0C\u5C07\u518D\u91CD\u8A66 ${max_attempts - attempts - 1} \u6B21 \x1B[91m\u2718\x1B[m`
          );
        }
      }
    } else {
      logger.info("\u5DF2\u7372\u5F97\u96D9\u500D\u7C3D\u5230\u734E\u52F5 \x1B[92m\u2714\x1B[m");
    }
    
    const final = await sign_status(page);
    const result = {
      signed: !!final.signin,
      doubled: !!final.finishedAd,
      days: final.days
    };
    if (shared.report) {
      shared.report.reports["\u7C3D\u5230"] = report(result);
    }
    logger.log(`\u57F7\u884C\u5B8C\u7562 \u2728`);
    return result;
  }
};

async function sign_status(page) {
  const { data } = await page.evaluate(async () => {
    // 優先使用網站內建 API
    if (typeof window.Signin !== 'undefined' && typeof window.Signin.checkSigninStatus === 'function') {
      try {
        const result = await window.Signin.checkSigninStatus();
        return result;
      } catch (e) {
        // 降級到 fetch 方式
      }
    }
    
    // 備用方案：直接調用 API
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 3e4);
    const r = await fetch("https://www.gamer.com.tw/ajax/signin.php", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: "action=2",
      signal: controller.signal
    });
    return r.json();
  });
  return data;
}

function report({ days, signed, doubled }) {
  let body = `# \u7C3D\u5230

`;
  body += `\u2728\u2728\u2728 \u5DF2\u9023\u7E8C\u7C3D\u5230 ${days} \u5929 \u2728\u2728\u2728
`;
  if (signed)
    body += `\u{1F7E2} \u4ECA\u65E5\u5DF2\u7C3D\u5230
`;
  else
    body += `\u274C \u4ECA\u65E5\u5C1A\u672A\u7C3D\u5230
`;
  if (doubled)
    body += `\u{1F7E2} \u5DF2\u7372\u5F97\u96D9\u500D\u7C3D\u5230\u734E\u52F5
`;
  else
    body += `\u274C \u5C1A\u672A\u7372\u5F97\u96D9\u500D\u7C3D\u5230\u734E\u52F5
`;
  body += "\n";
  return body;
}

export {
  sign_default as default
};
