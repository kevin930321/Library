import { Logger, utils } from "bahamut-automation";
import { authenticator } from "otplib";
import { MAIN_FRAME, solve } from "recaptcha-solver";

const { wait_for_cloudflare } = utils;

export default {
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
          await page.goto("https://user.gamer.com.tw/login.php");
          logger.log("登入中 ...");

          const precheck = page.waitForResponse((res) =>
            res.url().includes("login_precheck.php"),
          );
          const uid_locator = page.locator("#form-login input[name=userid]");
          const pw_locator = page.locator("#form-login input[type=password]");

          await uid_locator.fill(params.username);
          await pw_locator.fill(params.password);

          await precheck;

          await check_2fa(page, params.twofa, logger);
          if (await page.isVisible(MAIN_FRAME)) {
            await solve(page).catch((err) => logger.info(err.message));
          }
          await page.click("#form-login #btn-login");
          await page.waitForNavigation({ timeout: 3000 });
        } else {
          logger.log("登入狀態: 已登入");
          success = true;
          break;
        }
      } catch (err) {
        logger.error("登入時發生錯誤，重新嘗試中", err);
      }
    }

    // 尝试使用 API 登录
    try {
      logger.log("正在嘗試登入 API");

      // 使用 API 尝试登入
      const response = await page.request.post("https://api.gamer.com.tw/mobile_app/user/v3/do_login.php", {
        data: {
          uid: params.username, // 使用 params.username 获取用户名
          passwd: params.password, // 使用 params.password 获取密码
          vcode: '6666' // 使用固定的 vcode
        },
        headers: {
          'User-Agent': 'Bahadroid (https://www.gamer.com.tw/)',
          'Cookie': 'ckAPP_VCODE=6666'
        }
      });

      // 檢查登入結果
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
