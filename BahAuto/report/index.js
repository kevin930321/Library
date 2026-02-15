import { utils } from "bahamut-automation";
import { convert as html_to_text } from "html-to-text";
import markdownIt from "markdown-it";
import TurndownService from "turndown";
const { template } = utils;
const md = markdownIt();
const td = new TurndownService({ headingStyle: "atx" });
const DEFAULT_CONFIG = {
  title: "\u5DF4\u54C8\u81EA\u52D5\u5316\uFF01 \u5831\u544A $time$",
  ignore: ["login", "logout", "report"],
  only_failed: false
};
var report_default = {
  name: "Report",
  description: "\u5831\u544A",
  async run({ params, shared, logger }) {
    const config = Object.assign(
      {},
      DEFAULT_CONFIG,
      JSON.parse(JSON.stringify(params))
    );
    if (typeof config.ignore === "string")
      config.ignore = config.ignore.split(",");
    logger.log("DONE");
    const reports = {};
    return {
      title: template(config.title),
      reports,
      text: () => text(reports, config),
      markdown: () => markdown(reports, config),
      html: () => html(reports, config)
    };
  }
};
async function text(reports, config) {
  const { html: html2 } = await normalize(reports, config);
  const text2 = html_to_text(html2).replace(/\n\n\n+/g, "\n\n");
  return config.only_failed && !text2.includes("\u274C") ? "" : text2;
}
async function markdown(reports, config) {
  const { markdown: markdown2 } = await normalize(reports, config);
  return config.only_failed && !markdown2.includes("\u274C") ? "" : markdown2;
}
async function html(reports, config) {
  const { html: html2 } = await normalize(reports, config);
  return config.only_failed && !html2.includes("\u274C") ? "" : html2;
}
async function normalize(reports, config) {
  let report = "";
  for (const module in reports) {
    if (config.ignore.includes(module))
      continue;
    if (!reports[module])
      continue;
    const module_report = reports[module];
    if (typeof module_report === "string") {
      report += module_report + "\n";
    } else if (typeof module_report === "function") {
      report += await module_report() + "\n";
    }
  }
  const raw_md = template(report);
  const html2 = md.render(raw_md, {
    html: true,
    linkify: true,
    typographer: true
  });
  const markdown2 = td.turndown(html2);
  return { html: html2, markdown: markdown2 };
}
export {
  report_default as default
};
