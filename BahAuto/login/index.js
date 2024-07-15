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

      // 1. 訪問登入頁面，获取必要的 Cookie
      await page.goto("https://www.gamer.com.tw/");
      await wait_for_cloudflare(page);

      // 2. 获取必要的 Cookie，这里需要根据实际情况进行调整
      const vcodeCookie = await page.evaluate(() => {
        return document.cookie.match(/ckAPP_VCODE=([^;]+)/)[1];
      });

      // 3. 发出 API 请求
      const response = await page.request.post("https://api.gamer.com.tw/mobile_app/user/v3/do_login.php", {
        data: {
          uid: params.username, // 使用 params.username 获取用户名
          passwd: params.password, // 使用 params.password 获取密码
          vcode: vcodeCookie // 使用获取的 Cookie 中的 vcode
        },
        headers: {
          'User-Agent': 'Bahadroid (https://www.gamer.com.tw/)',
          'Cookie': `ckAPP_VCODE=${vcodeCookie}`
        }
      });

      // 4. 檢查登入結果
      if (response.status() === 200) {
        // 處理登入成功情況
        logger.log("登入成功");
        success = true;

        // 获取 BAHARUNE Cookie
        const BAHARUNE = response.headers()['Set-Cookie'].find(cookie => /BAHARUNE/.test(cookie));
        if (BAHARUNE) {
          const BAHARUNEValue = BAHARUNE.match(/(?<=BAHARUNE=)[^;]*(?=;)/)[0];
          // 将 BAHARUNE Cookie 保存到 shared 对象中
          shared.flags.BAHARUNE = BAHARUNEValue;
        }
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
