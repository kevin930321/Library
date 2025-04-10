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
        logger.log("正在嘗試使用 APP 登入...");

        const query = new URLSearchParams();
        query.append("userid", params.username);
        query.append("password", params.password);
        query.append("vcode", "7045");

        const headers = {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "Bahadroid (https://www.gamer.com.tw/)",
          "x-bahamut-app-instanceid": "cc2zQIfDpg4",
          "X-Bahamut-App-Version": "932",
          "X-Bahamut-App-Android": "tw.com.gamer.android.activecenter",
          "Connection": "Keep-Alive",
          "accept-encoding": "gzip",
          "cookie": "ckAPP_VCODE=7045",
        };
        
        //先導向首頁確認cloudflare
        await page.goto("https://www.gamer.com.tw/");
        await wait_for_cloudflare(page);

        // 進行登入前的 2FA 檢查 (調整成與API配合，如果有2FA，則一併傳遞)
        let twoFACode = "";
        if (params.twofa?.length) {
          twoFACode = authenticator.generate(params.twofa);
          query.append("twoStepAuth", twoFACode); //2fa
        }


        const res = await page.request.post("https://api.gamer.com.tw/mobile_app/user/v3/do_login.php", {
          data: query.toString(),
          headers: headers,
        });


        if (res.status() === 200) {
          const body = await res.json();

          if (body.result === "success") {
            logger.log("APP 登入成功");
            success = true;
            break;
          } else {
            logger.error("APP 登入失敗，訊息:", body.message || JSON.stringify(body)); //印出message或是整個body方便debug
          }
        } else {
          logger.error(`APP 登入請求失敗，狀態碼: ${res.status()}`);
        }

      } catch (err) {
        logger.error("嘗試 APP 登入時發生錯誤:", err);
      }
      await page.waitForTimeout(1000);
    }

    if (success) {
      shared.flags.logged = true;
    }

    return { success };
  },
};


export { login_default as default };