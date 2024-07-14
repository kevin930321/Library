import { fetch, utils } from "bahamut-automation";
import { authenticator } from "otplib";

const { goto } = utils;

const cookies = new Map();

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
      if (params.twofa?.length) {
        query.append("twoStepAuth", authenticator.generate(params.twofa));
      }
      try {
        const storedBahaRune = cookies.get("BAHARUNE");
        const storedBahaEnur = cookies.get("BAHAENUR");

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
          const cookiesString = res.headers.get("set-cookie");
          bahaRune = cookiesString.split(/(BAHARUNE=\w+)/)[1].split("=")[1];
          bahaEnur = cookiesString.split(/(BAHAENUR=\w+)/)[1].split("=")[1];
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
      cookies.set("BAHAID", params.username);
      cookies.set("BAHARUNE", bahaRune);
      cookies.set("BAHAENUR", bahaEnur);

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
