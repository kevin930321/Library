import { fetch } from "bahamut-automation";

var discord_default = {
  name: "Discord 通知",
  description: "發送通知至 Discord 聊天室",
  async run({ shared, params, logger }) {
    if (!shared.report) {
      logger.error("請設定 report 模組");
      return;
    }
    if (!params.webhook) {
      logger.error("請設定 Discord Webhook (webhook)");
      return;
    }
    if ((await shared.report.text()).length == 0) {
      logger.log("沒有報告內容");
      return;
    }

    // 取得原始 Markdown 內容
    const rawMarkdown = await shared.report.markdown();
    const lines = rawMarkdown.split("\n");

    // 1. 如果第一行是標題（以 # 開頭），則將其移除以避免與 Embed Title 重複
    if (lines.length > 0 && lines[0].trim().startsWith("#")) {
      lines.shift();
    }

    // 2. 重新組合、移除前後多餘換行，並將剩餘的 # 標題轉為粗體 **
    const msg = lines
      .join("\n")
      .trim()
      .replace(
        /^#+([^#].*)/gm,
        (match) => `**${match.replace(/^#+/, "").trim()}**`
      ) || "無詳細內容";

    // 3. 發送 Discord 通知，加入 timestamp 並優化顏色
    const { ok } = await fetch(params.webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: null,
        embeds: [
          {
            title: shared.report.title,
            color: 3447003, // Discord Blurple 顏色
            description: msg,
            timestamp: new Date().toISOString(), // 加入時間戳記
            footer: {
              text: "Bahamut Automation"
            }
          }
        ]
      })
    });

    if (ok) {
      logger.success("已發送 Discord 報告！");
    } else {
      logger.error("發送 Discord 報告失敗！");
      logger.error(msg);
    }
  }
};

export { discord_default as default };
