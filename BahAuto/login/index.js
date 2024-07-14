import { Logger, utils } from "bahamut-automation";
import { authenticator } from "otplib";
import { MAIN_FRAME, solve } from "recaptcha-solver";

const { wait_for_cloudflare } = utils;

export default {
  name: "Login",
  description: "登入",
  run: async ({ page, params, shared, logger }) => {
    let success = false;

    // 嘗試登入 API 端點
    try {
      logger.log("正在嘗試登入 API");
      const response = await page.request.post("https://api.gamer.com.tw/mobile_app/user/v3/do_login.php", {
        data: {
          username: params.username,
          password: params.password,
          // 其他必要的 API 參數
        },
        headers: {
          'User-Agent': 'Bahadroid (https://www.gamer.com.tw/)' // 在這裡設定 User-Agent
        }
      });

      // 檢查登入結果
      if (response.status() === 200) {
        // 處理登入成功情況
        logger.log("登入成功");
        success = true;
      } else {
        // 處理登入失敗情況
        logger.error("登入失敗", response.statusText());
      }
    } catch (err) {
      logger.error("登入時發生錯誤", err);
    }

    if (success) {
      shared.flags.logged = true;
    }

    return { success };
  },
};

async function check_2fa(page, twofa, logger) {
    const enabled = await page.isVisible("#form-login #input-2sa");

    if (enabled) {
        logger.log("有啟用 2FA");
        if (!twofa) {
            throw new Error("未提供 2FA 種子碼");
        }
        const code = authenticator.generate(twofa);
        await page.fill("#form-login #input-2sa", code);
        await page.evaluate(() => document.forms[0].submit());
    } else {
        logger.log("沒有啟用 2FA");
    }
}