import { utils } from "bahamut-automation";
import { authenticator } from "otplib";
import { MAIN_FRAME, solve } from "recaptcha-solver";
const { wait_for_cloudflare } = utils;

var login_default = {
  name: "Login",
  description: "\u767B\u5165",
  run: async ({ page, params, shared, logger }) => {
    let success = false;
    const apiUrl = 'https://api.gamer.com.tw/mobile_app/user/v3/do_login.php';
    const vcode = '7045'; // 這是範例驗證碼，需要根據實際情況更新
    
    await page.goto("https://www.gamer.com.tw/");
    await wait_for_cloudflare(page);
    
    const max_attempts = +params.max_attempts || +shared.max_attempts || 3;
    for (let i = 0; i < max_attempts; i++) {
      try {
        logger.log("\u6B63\u5728\u6AA2\u6E2C\u767B\u5165\u72C0\u614B");

        // 發送 POST 請求進行登入
        const response = await page.evaluate(async (apiUrl, username, password, vcode) => {
          const response = await fetch(apiUrl, {
            method: 'POST',
            headers: {
              'User-Agent': 'Bahadroid (https://www.gamer.com.tw/)',
              'Content-Type': 'application/x-www-form-urlencoded',
              'Cookie': `ckAPP_VCODE=${vcode}`
            },
            body: new URLSearchParams({
              uid: username,
              passwd: password,
              vcode: vcode
            })
          });

          const setCookie = response.headers.get('set-cookie');
          if (setCookie) {
            const match = /BAHARUNE=([^;]+)/.exec(setCookie);
            return match ? match[1] : null;
          }
          return null;
        }, apiUrl, params.username, params.password, vcode);

        if (response) {
          logger.log("\u767B\u5165\u6210\u529F");
          success = true;
          shared.flags.logged = true;
          break;
        } else {
          logger.log("\u767B\u5165\u5931\u6557\uFF0C\u91CD\u65B0\u5617\u8A66\u4E2D");
        }
      } catch (err) {
        logger.error("\u767B\u5165\u6642\u767C\u751F\u932F\u8AA4\uFF0C\u91CD\u65B0\u5617\u8A66\u4E2D", err);
      }
    }

    return { success };
  }
};

export {
  login_default as default
};
