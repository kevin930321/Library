import { utils } from "bahamut-automation";
import { authenticator } from "otplib";

const { wait_for_cloudflare } = utils;

var login_default = {
  name: "Login",
  description: "登入",
  run: async ({ page, params, shared, logger }) => {
    let success = false;
    await page.goto("https://www.gamer.com.tw/"); // 可以考慮移除這行，因為我們要模擬 App 行為
    await wait_for_cloudflare(page); // 可以考慮移除這行
    const max_attempts = +params.max_attempts || +shared.max_attempts || 3;

    for (let i = 0; i < max_attempts; i++) {
      try {
        logger.log("正在嘗試登入");
        const response = await page.evaluate(
          async ({ username, password }) => {
            return await fetch(
              "https://api.gamer.com.tw/mobile_app/user/v3/do_login.php",
              {
                method: "POST",
                headers: {
                  "User-Agent": "Bahadroid (https://www.gamer.com.tw/)",
                  Cookie: "ckAPP_VCODE=7045", // 注意，這裡的驗證碼需要動態取得
                },
                body: JSON.stringify({
                  uid: username,
                  passwd: password,
                  vcode: "7045", // 注意，這裡的驗證碼需要動態取得
                }),
              }
            );
          },
          { username: params.username, password: params.password }
        );

        const cookies = await response.headers().get("set-cookie");
        const baharuneCookie = cookies
          .split(";")
          .find((cookie) => cookie.trim().startsWith("BAHARUNE="));
        const baharuneValue = baharuneCookie
          ? baharuneCookie.split("=")[1]
          : null;

        if (baharuneValue) {
          logger.log("登入成功");
          await page.setCookie({
            name: "BAHARUNE",
            value: baharuneValue,
            domain: ".gamer.com.tw", // 設定 Cookie 的 domain
            path: "/", // 設定 Cookie 的 path
          });
          success = true;
          break;
        } else {
          logger.log("登入失敗: 無法取得 BAHARUNE Cookie");
          // 這裡可以加入處理兩步驟驗證的邏輯
        }
      } catch (err) {
        logger.error("登入時發生錯誤，重新嘗試中", err);
      }
    }

    if (success) {
      shared.flags.logged = true;
    }

    return { success };
  },
};

export default login_default;
