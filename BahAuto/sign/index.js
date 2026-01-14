import { utils } from "bahamut-automation";

const { goto } = utils;

var sign_default = {
  name: "簽到",
  description: "簽到模組 (API 版本)",
  async run({ page, shared, params, logger }) {
    if (!shared.flags.logged)
      throw new Error("使用者未登入，無法簽到");

    logger.log("開始執行");

    // 先前往首頁確保 cookie 正確
    await goto(page, "home");
    await page.waitForTimeout(1000);

    // 查詢簽到狀態
    let status = await sign_status(page, logger);
    logger.info(`已連續簽到天數: ${status.days}`);

    // 執行簽到
    if (!status.signin) {
      logger.warn("今日尚未簽到 \x1B[91m✘\x1B[m");
      logger.log("正在嘗試簽到...");

      try {
        const signResult = await do_signin(page, logger);
        if (signResult.ok) {
          logger.success("成功簽到 \x1B[92m✔\x1B[m");
          status = await sign_status(page, logger);
        } else {
          logger.error(`簽到失敗: ${signResult.message || '未知錯誤'}`);
        }
      } catch (err) {
        logger.error("簽到時發生錯誤:", err);
      }
    } else {
      logger.info("今日已簽到 \x1B[92m✔\x1B[m");
    }

    // 嘗試獲取雙倍獎勵 (使用 API)
    if (!status.finishedAd) {
      logger.log("嘗試獲取雙倍簽到獎勵...");

      const max_attempts = +params.double_max_attempts || 3;
      for (let attempts = 0; attempts < max_attempts; attempts++) {
        try {
          const doubleResult = await do_double_signin(page, logger);
          if (doubleResult.ok) {
            logger.success("已獲得雙倍簽到獎勵 \x1B[92m✔\x1B[m");
            status = await sign_status(page, logger);
            break;
          } else if (doubleResult.message?.includes("能量補充中")) {
            logger.warn("廣告能量補充中，稍後再試");
            await page.waitForTimeout(5000);
          } else {
            logger.warn(`嘗試 ${attempts + 1}/${max_attempts}: ${doubleResult.message || '未知錯誤'}`);
          }
        } catch (err) {
          logger.error(`嘗試 ${attempts + 1}/${max_attempts} 失敗:`, err);
        }

        if (attempts < max_attempts - 1) {
          await page.waitForTimeout(2000);
        }
      }
    } else {
      logger.info("已獲得雙倍簽到獎勵 \x1B[92m✔\x1B[m");
    }

    // 最終狀態
    const final = await sign_status(page, logger);
    const result = {
      signed: !!final.signin,
      doubled: !!final.finishedAd,
      days: final.days
    };

    if (shared.report) {
      shared.report.reports["簽到"] = report(result);
    }

    logger.log("執行完畢 ✨");
    return result;
  }
};

// 查詢簽到狀態
async function sign_status(page, logger) {
  try {
    const response = await page.request.post("https://www.gamer.com.tw/ajax/signin.php", {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      data: "action=2"
    });

    const result = await response.json();
    return result.data || { days: 0, signin: false, finishedAd: false };
  } catch (err) {
    logger.error("查詢簽到狀態失敗:", err);
    return { days: 0, signin: false, finishedAd: false };
  }
}

// 執行簽到
async function do_signin(page, logger) {
  try {
    const response = await page.request.post("https://www.gamer.com.tw/ajax/signin.php", {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      data: "action=1"
    });

    const result = await response.json();
    return { ok: result.data?.signin === 1, message: result.message, data: result.data };
  } catch (err) {
    logger.error("簽到請求失敗:", err);
    return { ok: false, message: err.message };
  }
}

// 執行雙倍簽到獎勵
async function do_double_signin(page, logger) {
  try {
    // 獲取 CSRF Token
    const tokenResponse = await page.request.get("https://www.gamer.com.tw/ajax/get_csrf_token.php");
    const csrfToken = (await tokenResponse.text()).trim();

    // 模擬觀看廣告完成
    const response = await page.request.post("https://www.gamer.com.tw/ajax/signin.php", {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      data: `action=3&token=${encodeURIComponent(csrfToken)}`
    });

    const result = await response.json();
    return { ok: result.data?.finishedAd === 1, message: result.message, data: result.data };
  } catch (err) {
    logger.error("雙倍獎勵請求失敗:", err);
    return { ok: false, message: err.message };
  }
}

function report({ days, signed, doubled }) {
  let body = `# 簽到

`;
  body += `✨✨✨ 已連續簽到 ${days} 天 ✨✨✨
`;
  if (signed)
    body += `🟢 今日已簽到
`;
  else
    body += `❌ 今日尚未簽到
`;
  if (doubled)
    body += `🟢 已獲得雙倍簽到獎勵
`;
  else
    body += `❌ 尚未獲得雙倍簽到獎勵
`;
  body += "\n";
  return body;
}

export {
  sign_default as default
};
