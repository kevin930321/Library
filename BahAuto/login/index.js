import { Logger, utils } from "bahamut-automation";
import { authenticator } from "otplib";
import { MAIN_FRAME, solve } from "recaptcha-solver";

const { wait_for_cloudflare } = utils;

export default {
    name: "Login",
    description: "登入",
    run: async ({ page, params, shared, logger }) => {
        let success = false;
        await page.goto("https://www.gamer.com.tw/");
        await wait_for_cloudflare(page);

        const max_attempts = +params.max_attempts || +shared.max_attempts || 3;
        for (let i = 0; i < max_attempts; i++) {
            try {
                logger.log("正在檢測登入狀態");
                await page.goto("https://www.gamer.com.tw/");
                await page.waitForTimeout(1000);

                await page
                    .waitForSelector("#driver-popover-content > button", { timeout: 5000 })
                    .then((el) => {
                        el.click();
                    })
                    .catch((err) => {});

                let not_login_signal = await page.waitForSelector("img.main-nav__profile");
                if (
                    not_login_signal &&
                    (await not_login_signal.getAttribute("src")).includes("none.gif")
                ) {
                    await page.goto("https://user.gamer.com.tw/login.php");
                    logger.log("登入中 ...");

                    const precheck = page.waitForResponse((res) =>
                        res.url().includes("login_precheck.php"),
                    );
                    const uid_locator = page.locator("#form-login input[name=userid]");
                    const pw_locator = page.locator("#form-login input[type=password]");

                    await uid_locator.fill(params.username);
                    await pw_locator.fill(params.password);

                    await precheck;

                    await check_2fa(page, params.twofa, logger);
                    if (await page.isVisible(MAIN_FRAME)) {
                        await solve(page).catch((err) => logger.info(err.message));
                    }
                    await page.click("#form-login #btn-login");
                    await page.waitForNavigation({ timeout: 3000 });
                } else {
                    logger.log("登入狀態: 已登入");
                    success = true;
                    break;
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

async function check_2fa(page, twofa, logger) {
    const enabled = await page.isVisible("#form-login #input-2sa");

    if (enabled) {
        logger.log("有啟用 2FA");
        if (!twofa) {
            throw new Error("未提供 2FA 種子碼");
        }
        const code = authenticator.generate(twofa);
        await page.fill("#form-login #input-2sa", code);
        await page.evaluate(() => document.forms[0].submit());
    } else {
        logger.log("沒有啟用 2FA");
    }
}