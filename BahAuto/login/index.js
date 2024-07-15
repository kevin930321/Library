import { Logger, utils } from "bahamut-automation";
import { authenticator } from "otplib";

const { fetch, goto } = utils;

export default {
  name: "Login",
  description: "登入",
  run: async ({ page, params, shared, logger }) => {
    logger.log("Login started");
    let success = false;
    let bahaRune = "";
    let bahaEnur = "";

    const max_attempts = +params.max_attempts || +shared.max_attempts || 3;
    for (let i = 0; i < max_attempts; i++) {
      const query = new URLSearchParams();
      query.append("uid", params.username);
      query.append("passwd", params.password);
      query.append("vcode", "6666");
      if (params.twofa?.length) {
        query.append("twoStepAuth", authenticator.generate(params.twofa));
      }

      try {
        const res = await fetch(
          "https://api.gamer.com.tw/mobile_app/user/v3/do_login.php",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
              "User-Agent": "Bahadroid (https://www.gamer.com.tw/)",
              "Cookie": "ckAPP_VCODE=6666"
            },
            body: query.toString(),
          }
        );

        const body = await res.json();

        if (body.userid) {
          const cookies = res.headers.get("set-cookie");
          bahaRune = cookies.split(/(BAHARUNE=\w+)/)[1].split("=")[1];
          bahaEnur = cookies.split(/(BAHAENUR=\w+)/)[1].split("=")[1];
          logger.success("✅ 登入成功");
          success = true; // 將 success 設定為 true
          break;
        } else {
          result = body.message;
        }
      } catch (err) {
        logger.error(err);
        result.error = err;
      }
      logger.error("❌ 登入失敗: ", result.error);
      await page.waitForTimeout(1000);
    }

    // 儲存登入狀態到 shared.flags.logged
    shared.flags.logged = success; // 使用 success 來更新 shared.flags.logged
    return { success }; 
  }
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
