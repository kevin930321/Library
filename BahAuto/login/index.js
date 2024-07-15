import { Logger, utils } from "bahamut-automation";
import { authenticator } from "otplib";

const { fetch, goto } = utils;

export default {
  name: "Login",
  description: "登入",
  run: async ({ page, params, shared, logger }) => {
    logger.log("Login started");
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
        // 使用 page.request 進行 API 請求
        const res = await page.request.post("https://api.gamer.com.tw/mobile_app/user/v3/do_login.php", {
          data: query.toString(),
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": "Bahadroid (https://www.gamer.com.tw/)",
            "x-bahamut-app-instanceid": "cc2zQIfDpg4",
            "X-Bahamut-App-Version": "932",
            "X-Bahamut-App-Android": "tw.com.gamer.android.activecenter",
            "Connection": "Keep-Alive",
            "accept-encoding": "gzip",
            "cookie": "ckAPP_VCODE=7045",
          },
        });

        if (res.status() === 200) {
          // 檢查登入結果
          success = true;
          logger.success("✅ 登入成功");
          break;
        } else {
          // 處理登入失敗情況
          const body = await res.json();
          logger.error("❌ 登入失敗: ", body.message);
        }
      } catch (err) {
        logger.error("❌ 登入失敗: ", err);
      }
      await page.waitForTimeout(1000);
    }

    // 將登入狀態存入 shared.flags.logged
    if (success) {
      shared.flags.logged = true;
    }

    return { success };
  }
};
