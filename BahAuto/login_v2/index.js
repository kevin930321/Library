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
          const cookies = res.headers.raw()["set-cookie"];
          for (const cookie of cookies) {
            if (cookie.includes("BAHARUNE")) {
              bahaRune = cookie.match(/BAHARUNE=(\w+)/)[1];
            }
            if (cookie.includes("BAHAENUR")) {
              bahaEnur = cookie.match(/BAHAENUR=(\w+)/)[1];
            }
          }
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
      await page.reload();
      await page.waitForTimeout(1000);

      // 新增：檢查登入狀態
      const loggedIn = await page.evaluate(() => {
        return document.cookie.includes('BAHARUNE') && document.cookie.includes('BAHAENUR');
      });
      if (loggedIn) {
        logger.success("✅ 登入 Cookie 已載入且檢查成功");
        result.success = true;
      } else {
        logger.error("❌ Cookie 檢查失敗");
        result.success = false;
      }
    } else {
      result.success = false;
    }

    if (result.success) {
      shared.flags.logged = true;
    }

    return result;
  }
};
