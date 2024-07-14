import { fetch, utils } from "bahamut-automation";
import { authenticator } from "otplib";
import { localStorage } from 'localstorage-polyfill'; // 引入 localstorage-polyfill

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
        // 初始化 localstorage-polyfill
        localStorage.config({
          deserializer: (value) => JSON.parse(value),
          serializer: (value) => JSON.stringify(value)
        });

        // 從 localStorage 載入 Cookie
        const storedBahaRune = localStorage.getItem("BAHARUNE");
        const storedBahaEnur = localStorage.getItem("BAHAENUR");

        // 使用 Cookie 發送請求
        const res = await fetch(
          "https://api.gamer.com.tw/mobile_app/user/v3/do_login.php",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
              Cookie: `BAHARUNE=${storedBahaRune}; BAHAENUR=${storedBahaEnur}`,
              "User-Agent": "Bahadroid (https://www.gamer.com.tw/)",
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
      // 儲存 Cookie 到 localStorage
      localStorage.setItem("BAHAID", params.username);
      localStorage.setItem("BAHARUNE", bahaRune);
      localStorage.setItem("BAHAENUR", bahaEnur);

      await goto(page, "home");
      const context = page.context();
      await context.addInitScript(
        ([BAHAID, BAHARUNE, BAHAENUR]) => {
          document.cookie = `BAHAID=${BAHAID}; path=/; domain=.gamer.com.tw`;
          document.cookie = `BAHARUNE=${BAHARUNE}; path=/; domain=.gamer.com.tw`;
          document.cookie = `BAHAENUR=${BAHAENUR}; path=/; domain=.gamer.com.tw`;
        },
        [params.username, bahaRune, bahaEnur]
      );
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
  }
};
