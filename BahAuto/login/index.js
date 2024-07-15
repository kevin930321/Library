import { Logger, utils } from "bahamut-automation";
import { authenticator } from "otplib";

const { goto } = utils;

export default {
  name: "Login",
  description: "登入",
  run: async ({ page, params, shared, logger }) => {
    logger.log(`Login started`);
    let result: any = {};
    let bahaRune = "";
    let bahaEnur = "";

    const max_attempts = +params.max_attempts || +shared.max_attempts || 3;
    for (let i = 0; i < max_attempts; i++) {
      try {
        const response = await page.request.post(
          "https://api.gamer.com.tw/mobile_app/user/v3/do_login.php",
          {
            data: {
              uid: params.username,
              passwd: params.password,
              vcode: "6666", // 這裡可以根據需求設定
              twoStepAuth: params.twofa
                ? authenticator.generate(params.twofa)
                : undefined,
            },
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
              "User-Agent": "Bahadroid (https://www.gamer.com.tw/)",
              Cookie: "ckAPP_VCODE=6666", // 這裡可以根據需求設定
            },
          },
        );

        if (response.status() === 200) {
          const cookies = response.headers().get("set-cookie");
          bahaRune = cookies
            .split(/(BAHARUNE=\w+)/)[1]
            .split("=")[1];
          bahaEnur = cookies
            .split(/(BAHAENUR=\w+)/)[1]
            .split("=")[1];
          logger.success(`✅ 登入成功`);
          break;
        } else {
          // 處理登入失敗情況，例如獲取錯誤訊息
          result = response.json();
        }
      } catch (err) {
        logger.error(err);
        result.error = err;
      }

      logger.error(`❌ 登入失敗: `, result.error);
      await page.waitForTimeout(1000);
    }

    if (bahaRune && bahaEnur) {
      await goto(page, "home");
      const context = page.context();
      await context.addInitScript(
        ([BAHAID, BAHARUNE, BAHAENUR]: [string, string, string]) => {
          document.cookie = `BAHAID=${BAHAID}; path=/; domain=.gamer.com.tw`;
          document.cookie = `BAHARUNE=${BAHARUNE}; path=/; domain=.gamer.com.tw`;
          document.cookie = `BAHAENUR=${BAHAENUR}; path=/; domain=.gamer.com.tw`;
        },
        [params.username, bahaRune, bahaEnur],
      );
      await goto(page, "home");
      await page.waitForTimeout(1000);
      logger.success(`✅ 登入 Cookie 已載入`);
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
