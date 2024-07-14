import { utils } from "bahamut-automation";
import { authenticator } from "otplib";
import { MAIN_FRAME, solve } from "recaptcha-solver";
const { wait_for_cloudflare } = utils;

var login_default = {
  name: "Login",
  description: "登入",
  run: async ({ params, shared, logger }) => {
    let success = false;
    const max_attempts = +params.max_attempts || +shared.max_attempts || 3;
    for (let i = 0; i < max_attempts; i++) {
      try {
        logger.log("正在檢測登入狀態");
        const response = await UrlFetchApp.fetch("https://www.gamer.com.tw/");
        await wait_for_cloudflare(response); // 這邊需要修改 wait_for_cloudflare 函式來處理 UrlFetchApp.fetch 的結果
        if (response.getResponseCode() === 200) { 
          // 檢查是否已登入，例如檢查回應內容是否包含特定元素
          if (/* 檢查是否已登入 */) {
            logger.log("登入狀態: 已登入");
            success = true;
            break;
          } else {
            logger.log("尚未登入，正在嘗試登入...");
            const loginResponse = await UrlFetchApp.fetch('https://api.gamer.com.tw/mobile_app/user/v3/do_login.php', {
              'method': 'POST',
              'payload': {
                'uid': params.username,
                'passwd': params.password,
                'vcode': '7045' // 這邊需要想辦法取得最新的驗證碼
              },
              'headers': {
                'User-Agent': 'Bahadroid (https://www.gamer.com.tw/)',
                'Cookie': 'ckAPP_VCODE=7045' // 這邊也需要想辦法取得最新的驗證碼
              }
            });

            if (loginResponse.getResponseCode() === 200) {
              const baharuneCookie = loginResponse.getAllHeaders()['Set-Cookie'].find(cookie => /BAHARUNE/.test(cookie));
              if (baharuneCookie) {
                const baharuneValue = baharuneCookie.match(/(?<=BAHARUNE=)[^;]*(?=;)/)[0]; 
                logger.log("登入成功！BAHARUNE: " + baharuneValue);
                success = true;
                break;
              } else {
                logger.log("登入失敗，找不到 BAHARUNE Cookie");
              }
            } else {
              logger.log("登入請求失敗: " + loginResponse.getResponseCode());
            }
          }
        } else {
          logger.log("無法訪問網站: " + response.getResponseCode());
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

export default login_default;
