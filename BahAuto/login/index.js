import { Logger, utils } from "bahamut-automation";
import { authenticator } from "otplib";
import { MAIN_FRAME, solve } from "recaptcha-solver";

const { wait_for_cloudflare } = utils;

export default {
  name: "Login",
  description: "登入",
  run: async ({ page, params, shared, logger }) => {
    let success = false;

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
        const response = await page.request.post(
          "https://api.gamer.com.tw/mobile_app/user/v3/do_login.php",
          {
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
              "User-Agent": "Bahadroid (https://www.gamer.com.tw/)",
              "Cookie": "ckAPP_VCODE=6666",
            },
            data: query.toString(),
          }
        );

        const body = await response.json();

        if (body.userid) {
          const cookies = response.headers()["set-cookie"];
          const bahaRune = cookies.split(/(BAHARUNE=\w+)/)[1].split("=")[1];
          const bahaEnur = cookies.split(/(BAHAENUR=\w+)/)[1].split("=")[1];

          // 使用新的方式儲存 Cookie
          await page.context().addCookies([
            {
              name: "BAHAID",
              value: params.username,
              domain: ".gamer.com.tw",
              path: "/",
            },
            {
              name: "BAHARUNE",
              value: bahaRune,
              domain: ".gamer.com.tw",
              path: "/",
            },
            {
              name: "BAHAENUR",
              value: bahaEnur,
              domain: ".gamer.com.tw",
              path: "/",
            },
          ]);

          logger.success("✅ 登入成功");
          success = true;
          break;
        } else {
          logger.error("❌ 登入失敗: ", body.message);
        }
      } catch (err) {
        logger.error("登入時發生錯誤: ", err);
      }
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
