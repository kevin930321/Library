import { NotFoundError, solve } from "recaptcha-solver";
import { Pool } from "@jacoblincool/puddle";
var lottery_default = {
name: "福利社",
description: "福利社抽獎",
async run({ page, shared, params, logger }) {
if (!shared.flags.logged)
throw new Error("使用者未登入，無法抽獎");
if (!shared.ad_handler)
throw new Error("需使用 ad_handler 模組");
logger.log(開始執行);
let lottery = 0;
logger.log("正在尋找抽抽樂");
const draws = await getList(page, logger);
logger.log(找到 ${draws.length} 個抽抽樂);
const unfinished = {};
draws.forEach(({ name, link }, i) => {
logger.log(${i + 1}: ${name});
unfinished[name] = link;
});
const PARRALLEL = +params.max_parallel || 1;
const MAX_ATTEMPTS = +params.max_attempts || +shared.max_attempts || 20;
const CHANGING_RETRY = +params.changing_retry || +shared.changing_retry || 3;
const context = page.context();
const pool = new Pool(PARRALLEL);
for (let i = 0; i < draws.length; i++) {
pool.push(async () => {
const idx = i;
const { link, name } = draws[idx];
const task_page = await context.newPage();
const recaptcha = { process: false };
task_page.on("response", async (response) => {
if (response.url().includes("recaptcha/api2/userverify")) {
const text = (await response.text()).replace(")]}'\n", "");
const data = JSON.parse(text);
recaptcha.process = data[2] === 0;
}
if (response.url().includes("recaptcha/api2/reload")) {
const text = (await response.text()).replace(")]}'\n", "");
const data = JSON.parse(text);
recaptcha.process = data[5] !== "nocaptcha";
}
});
for (let attempts = 1; attempts <= MAX_ATTEMPTS; attempts++) {
try {
await task_page.goto(link);
await task_page.waitForSelector("#BH-master > .BH-lbox.fuli-pbox h1");
await task_page.waitForTimeout(100);
if (await task_page.$(".btn-base.c-accent-o.is-disable")) {
logger.log(${name} 的廣告免費次數已用完 \u001b[92m✔\u001b[m);
delete unfinished[name];
break;
}
logger.log([${idx + 1} / ${draws.length}] (${attempts}) ${name});

// 嘗試跳過廣告的邏輯
logger.log("正在嘗試跳過廣告");
for (let retried = 1; retried <= CHANGING_RETRY; retried++) {
await Promise.all([
task_page.waitForResponse(/ajax/check_ad.php/, { timeout: 5e3 }).catch(() => {}),
task_page.click("text=看廣告免費兌換").catch(() => {}),
task_page.waitForSelector(".fuli-ad__qrcode", { timeout: 5e3 }).catch(() => {})
]);

const chargingText = await task_page.$eval(
".dialogify .dialogify__body p",
(elm) => elm.innerText
).catch(() => {}) || "";

if (chargingText.includes("廣告能量補充中")) {
logger.info(廣告能量補充中，重試 (${retried}/${CHANGING_RETRY}));
await task_page.click("button:has-text('關閉')");
continue;
}
break;
}

// 跳過廣告後進入結算頁面的邏輯
const final_url = task_page.url();
if (final_url.includes("/buyD.php") && final_url.includes("ad=1")) {
logger.log(正在確認結算頁面);
await checkInfo(task_page, logger).catch((...args) => logger.error(...args));
await confirm(task_page, logger, recaptcha).catch((...args) => logger.error(...args));

if (await task_page.$(".card > .section > p") && await task_page.$eval(
".card > .section > p",
(elm) => elm.innerText.includes("成功")
)) {
logger.success(已完成一次抽抽樂：${name} \u001b[92m✔\u001b[m);
lottery++;
} else {
logger.error("發生錯誤，重試中 \u001b[91m✘\u001b[m");
}
} else {
logger.warn(final_url);
logger.error("未進入結算頁面，重試中 \u001b[91m✘\u001b[m");
}
} catch (err) {
logger.error("!", err);
}
}
await task_page.close();
});
}
await pool.go();
await page.waitForTimeout(2e3);
logger.log(執行完畢 ✨);
if (shared.report) {
shared.report.reports["福利社抽獎"] = report({ lottery, unfinished });
}
return { lottery, unfinished };
}
};
async function getList(page, logger) {
let draws;
await page.context().addCookies([{ name: "ckFuli_18UP", value: "1", domain: "fuli.gamer.com.tw", path: "/" }]);
let attempts = 3;
while (attempts-- > 0) {
draws = [];
try {
await page.goto("https://fuli.gamer.com.tw/shop.php?page=1");
let items = await page.$$("a.items-card");
for (let i = items.length - 1; i >= 0; i--) {
let is_draw = await items[i].evaluate(
(elm) => elm.innerHTML.includes("抽抽樂")
);
if (is_draw) {
draws.push({
name: await items[i].evaluate(
(node) => node.querySelector(".items-title").innerHTML
),
link: await items[i].evaluate((elm) => elm.href)
});
}
}
while (await page.$eval(
"a.pagenow",
(elm) => elm.nextSibling ? true : false
)) {
await page.goto(
"https://fuli.gamer.com.tw/shop.php?page=" + await page.$eval(
"a.pagenow",
(elm) => elm.nextSibling.innerText
)
);
let items2 = await page.$$("a.items-card");
for (let i = items2.length - 1; i >= 0; i--) {
let is_draw = await items2[i].evaluate(
(node) => node.innerHTML.includes("抽抽樂")
);
if (is_draw) {
draws.push({
name: await items2[i].evaluate(
(node) => node.querySelector(".items-title").innerHTML
),
link: await items2[i].evaluate((elm) => elm.href)
});
}
}
}
break;
} catch (err) {
logger.error(err);
}
}
return draws;
}
async function checkInfo(page, logger) {
try {
const name = await page.$eval("#name", (elm) => elm.value);
const tel = await page.$eval("#tel", (elm) => elm.value);
const city = await page.$eval("[name=city]", (elm) => elm.value);
const country = await page.$eval("[name=country]", (elm) => elm.value);
const address = await page.$eval("#address", (elm) => elm.value);
if (!name)
logger.log("無收件人姓名");
if (!tel)
logger.log("無收件人電話");
if (!city)
logger.log("無收件人城市");
if (!country)
logger.log("無收件人區域");
if (!address)
logger.log("無收件人地址");
if (!name || !tel || !city || !country || !address)
throw new Error("警告：收件人資料不全");
} catch (err) {
logger.error(err);
}
}
async function confirm(page, logger, recaptcha) {
try {
await page.waitForSelector("input[name='agreeConfirm']", { state: "attached" });
if (await (await page.$("input[name='agreeConfirm']")).getAttribute("checked") === null) {
await page.click("text=我已閱讀注意事項，並確認兌換此商品");
}
await page.waitForTimeout(100);
await page.waitForSelector("a:has-text('確認兌換')");
await page.click("a:has-text('確認兌換')");
const next_navigation = page.waitForNavigation().catch(() => {});
await page.waitForSelector("button:has-text('確定')");
await page.click("button:has-text('確定')");
await page.waitForTimeout(300);
if (recaptcha.process === true) {
const recaptcha_frame_width = await page.$eval(
"iframe[src^='https://www.google.com/recaptcha/api2/bframe']",
(elm) => getComputedStyle(elm).width
);
if (recaptcha_frame_width !== "100%") {
logger.log("需要處理 reCAPTCHA");
try {
await timeout_promise(solve(page, { delay: 64 }), 3e4);
} catch (err) {
if (err instanceof NotFoundError)