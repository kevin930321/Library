import { utils } from "bahamut-automation";
import { authenticator } from "otplib";

const { wait_for_cloudflare } = utils;

var login_default = {
  name: "Login",
  description: "登入",
  run: async ({ page, params, shared, logger }) => {
    let success = false;
    const max_attempts = +params.max_attempts || +shared.max_attempts || 3;

    for (let i = 0; i < max_attempts; i++) {
      try {
        logger.log("正在檢測登入狀態");
        await page.goto("https://www.gamer.com.tw/");
        await wait_for_cloudflare(page);

        // 嘗試關閉可能出現的彈出視窗
        await page
          .waitForSelector("#driver-popover-content > button", { timeout: 5000 })
          .then(async (el) => {
            await el.click();
            logger.log("關閉了彈出視窗");
          })
          .catch((err) => {
            logger.warn("無法找到或點擊彈出視窗按鈕，可能已被關閉: " + err.message);
          });

        // 檢測是否已登入
        let not_login_signal = await page.waitForSelector("img.main-nav__profile", { timeout: 5000 }).catch(() => null);
        if (!not_login_signal) {
          logger.warn("無法找到登入圖示，可能網站有變更");
        } else {
          const profileImgSrc = (await not_login_signal.getAttribute("src")) || "";
          if (!profileImgSrc.includes("none.gif")) {
            logger.log("登入狀態: 已登入");
            success = true;
            break;
          }
        }

        logger.log("登入中 ...");

        const query = new URLSearchParams();
        query.append("uid", params.username);
        query.append("passwd", params.password);
        query.append("vcode", "7045");

        if (params.twofa?.length) {
          query.append("twoStepAuth", authenticator.generate(params.twofa));
        }

        const res = await page.request.post("https://api.gamer.com.tw/mobile_app/user/v3/do_login.php", {
          data: query.toString(),
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": "Bahadroid (https://www.gamer.com.tw/)",
            "x-bahamut-app-instanceid": "cc2zQIfDpg4",
            "X-Bahamut-App-Version": "982",
            "X-Bahamut-App-Android": "tw.com.gamer.android.activecenter",
            "Connection": "Keep-Alive",
            "accept-encoding": "gzip",
            "cookie": "ckAPP_VCODE=7045",
          },
        });


        if (res.status() === 200) {
          const body = await res.json();
          logger.log("API 登入成功", body);

          // 取得 API 回應中的 set-cookie 標頭
          const setCookieHeaders = res.headers()['set-cookie'];
          if (setCookieHeaders) {
            const cookies = setCookieHeaders.map(header => {
              const cookiePairs = header.split(';');
              const cookieObj = {};
              cookiePairs.forEach(pair => {
                const [key, ...values] = pair.trim().split('=');
                cookieObj[key] = values.join('=');
              });
              return cookieObj;
            });
            const setCookies = setCookieHeaders.split(';').map(cookie => {
              let [name, value] = cookie.trim().split('=');

              // 若沒有值則設定為空字串
              if (value === undefined) {
                value = '';
              }
            });
            if (Array.isArray(setCookieHeaders))
              setCookieHeaders.forEach(header => {
                  const cookieString = header.split(';')[0]; // 取第一個 cookie, 因為剩下的都是 attribute
                  const [cookieName, cookieValue] = cookieString.split('=');
              })

            //await page.context().addCookies(setCookies);
            await page.context().addCookies(
              setCookieHeaders.split(';').map(cookie => {
                let [name, value] = cookie.trim().split('=');
          
                // 若沒有值則設定為空字串
                if (value === undefined) {
                  value = '';
                }

                const obj = {
                  name: name,
                  value: value,
                  domain: '.gamer.com.tw', // 確保設定正確的 domain
                  path: '/',
                };
          
                // 檢查 obj 屬性
                if (!obj.name || !obj.value) {
                  logger.warn('無效的 Cookie:', obj);
                }
          
                return obj;
            })
            );
            logger.log('已設定 Cookies:');
          }

           // 等待網頁載入完成 (包括網路空閒)
          await page.goto("https://www.gamer.com.tw/");
          await page.waitForLoadState('networkidle');
          await page.waitForTimeout(1000);


          // 確認登入狀態 - 等待登入後才會出現的元素
          try {
            await page.waitForSelector(".main-nav__name", { timeout: 10000 }); // 將 .會員登入後才有的選擇器 替換成登入後才出現的元素
            logger.log("成功登入，已找到會員專屬元素");
            success = true;
            break;

          } catch (e) {
            logger.warn("雖然 API 登入成功，但會員專屬元素未出現，可能登入未同步");
          }


          logger.success("✅ 登入成功");
          success = true;
          break;

        } else {
          const body = await res.json();
          logger.error("❌ 登入失敗: ", body);
        }

      } catch (err) {
        logger.error("登入時發生錯誤，重新嘗試中", err);
      }
    }

    if (success) {
      shared.flags.logged = true;
    }

    return { success };
  },
};

export { login_default as default };