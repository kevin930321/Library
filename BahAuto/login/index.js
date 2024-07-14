import { utils } from "bahamut-automation";
import { authenticator } from "otplib";
import { MAIN_FRAME, solve } from "recaptcha-solver";

const { wait_for_cloudflare } = utils;

var login_default = {
  name: "Login",
  description: "登入",
  run: async ({ page, params, shared, logger }) => {
    let success = false;
    await page.goto("https://www.gamer.com.tw/");
    await wait_for_cloudflare(page);
    const max_attempts = +params.max_attempts || +shared.max_attempts || 3;
    for (let i = 0; i < max_attempts; i++) {
      try {
        logger.log("正在檢測登入狀態");
        await page.goto("https://www.gamer.com.tw/");
        await page.waitForTimeout(1000);

        let not_login_signal = await page.$("div.TOP-my.TOP-nologin");
        if (not_login_signal) {
          logger.log("尚未登入，正在嘗試登入...");

          // 前往登入頁面
          await page.goto("https://api.gamer.com.tw/mobile_app/user/v3/do_login.php");

          // 填寫帳號密碼
          await page.type("#form-login input[name=userid]", params.username);
          await page.type("#form-login input[type=password]", params.password);

          // 處理驗證碼
          const vcodeElement = await page.$("#form-login input[name=vcode]"); 
          if (vcodeElement) {
            logger.log("需要輸入驗證碼...");
            // 這邊需要根據實際情況處理驗證碼，例如使用圖像識別API
            // const captcha = await solveCaptcha(page); 
            // await page.type("#form-login input[name=vcode]", captcha);
          }

          // 處理兩步驟驗證
          await check_2fa(page, params.twofa, logger);

          // 提交登入表單
          await Promise.all([
            page.waitForNavigation(),
            page.click("#form-login #btn-login")
          ]);

          // 檢查是否登入成功
          const baharuneCookie = await page.cookies().find(cookie => cookie.name === 'BAHARUNE');
          if (baharuneCookie) {
            logger.log("登入成功！BAHARUNE: " + baharuneCookie.value);
            success = true;
            break;
          } else {
            logger.log("登入失敗，找不到 BAHARUNE Cookie");
          }
        } else {
          logger.log("登入狀態: 已登入");
          success = true;
          break;
        }
      } catch (err) {
        logger.error("登入時發生錯誤，重新嘗試中", err);
      }
    }

    if (success) {
      shared.flags.logged = true;
    }
    return { success };
  }
};

async function check_2fa(page, twofa, logger) {
  const enabled = await page.isVisible("#form-login #input-2sa");
  if (enabled) {
    logger.log("有啟用 2FA");
    if (!twofa) {
      throw new Error("請提供 2FA 種子碼");
    }
    const code = authenticator.generate(twofa);
    await page.fill("#form-login #input-2sa", code);
  } else {
    logger.log("沒有啟用 2FA");
  }
}

export {
  login_default as default
};
