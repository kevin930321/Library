import { fetch, utils } from "bahamut-automation";
import { authenticator } from "otplib";

const { goto } = utils;

export default {
  name: "Login",
  description: "登入",
  run: async ({ page, params, shared, logger }) => {
    logger.log("Login started");
    let result = {};
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
              Cookie: "ckAPP_VCODE=6666",
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

    if (bahaRune && bahaEnur) {
      // --- 模擬瀏覽器行為 ---

      // 攔截 token 請求
      await page.route('https://www.gamer.com.tw/ajax/get_csrf_token.php*', async (route) => {
        const tokenResponse = await page.request.fetch(route.request());
        const token = await tokenResponse.text();
        // 在這裡處理 token，例如打印出來
        console.log('Token:', token); 

        // 繼續處理請求
        route.continue();
      });

      // 模擬發送簽到請求
      await page.evaluate(async (bahaRune) => {
        // --- 設定 User-Agent ---
        const originalFetch = window.fetch;
        window.fetch = async (url, options = {}) => {
          options.headers = {
            ...(options.headers || {}),
            'User-Agent': 'Bahadroid (https://www.gamer.com.tw/)',
            //  --- 加入 Referer 頭 ---
            'Referer': 'https://www.gamer.com.tw/',
            //  --- 加入 Referer 頭 結束 ---
          };
          return originalFetch(url, options);
        };
        // --- 設定 User-Agent 結束 ---

        const tokenResponse = await fetch('https://www.gamer.com.tw/ajax/get_csrf_token.php');
        const token = await tokenResponse.text();

        const response = await fetch('https://www.gamer.com.tw/ajax/signin.php', {
          method: 'POST',
          headers: {
            'Cookie': `BAHARUNE=${bahaRune}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: `action=1&token=${encodeURIComponent(token)}`, // 注意 token 需要 URL 編碼
        });

        const data = await response.json();
        console.log('Signin response:', data);
      }, bahaRune);

      // --- 模擬結束 ---

      await goto(page, "home");
      await page.waitForTimeout(1000);
      logger.success("✅ 登入 Cookie 已載入");
      result.success = true;
    } else {
      result.success = false;
    }

    if (result.success) {
      shared.flags.logged = true;
    }

    return result;
  },
};
