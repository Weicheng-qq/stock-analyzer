// 最新財報 AI 分析 —— 消費 detect-events.mjs 產生的佇列（台股 + 美股）
//
// 【設計原則】
// 1. Gemini 只負責「分析已經取得的官方數字」，絕不讓它去搜尋公司（那是 detect-events 的工作）。
// 2. 同一家公司、同一季只分析一次：輸出檔已存在且季度相同就跳過。
// 3. 名額分配：使用者點過的 → 五階段 1→5 → 其他（2026-09-19 使用者指定，見主流程排序處）；
//    同一層內再依熱門股 → 有官網 IR 頁 → 事件優先度 HIGH → MEDIUM → LOW。額度用完就停。
// 4. 【零費用鐵則】三層免費備援 Gemini→Groq→OpenRouter（見 lib/ai-call.mjs，與網站 /api/ai 一致）。
//    三家都只用免費層，超額一律是「拒絕請求」而非計費，三家都用完就停止。
//    ⚠️ Gemini 一旦啟用帳單，免費層會整個消失、從第一個 token 就計費。
// 5. 所有財務數字必須來自官方原始資料，AI 只做整理與判讀；資料沒有的一律寫「未提供」。
//
// 【輸出】data/earnings/{代碼}.json —— 以「代碼」為檔名、季度寫在內容裡。
//    為什麼不用季度當檔名：公司的會計年度季別與人工 IR 記錄的季度可能不一致
//    （例如 NVDA 的 SEC 會計期間是 FY2027Q2，人工記錄寫「2026 第二季」），
//    用季度當檔名會讓前端算出的鍵對不上而永遠找不到檔案。
//
// 【資料來源（全部免費官方，皆已實測 HTTP 200）】
//   台股：TWSE/TPEx OpenAPI 季度損益表 —— 2 個請求拿到全部 1909 家公司
//   美股：SEC XBRL companyfacts —— data.sec.gov/api/xbrl/companyfacts/CIK{10碼}.json
//         逐家查詢，但佇列一天只有數十家，對 SEC 的頻率規範完全無虞。
//         （另有 frames API 可一次拿全市場，但它以「日曆季」對齊，
//           像 NVDA 這種會計年度不對齊日曆季的公司會查不到營收，故採 companyfacts。）

import fs from 'node:fs';
import path from 'node:path';
import { fetchLatestEarningsRelease, focusExcerpt } from './lib/sec-press-release.mjs';
import { fetchCallIndex, fetchCallPdfText, focusExcerptTw } from './lib/mops-earnings-call.mjs';
import { fetchIrDocument, focusExcerptIr, focusExcerptDocs, closeBrowser } from './lib/ir-transcript.mjs';
// 三層備援(Gemini→Groq→OpenRouter)，與網站 /api/ai 行為一致
import { callAI, aiStats, shouldStop } from './lib/ai-call.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT_DIR = process.env.OUT_DIR ? path.resolve(process.env.OUT_DIR) : path.join(ROOT, 'data', 'earnings');   // OUT_DIR：測試時指到暫存資料夾
const UA_TW = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const UA_SEC = 'StockAnalyzer/1.0 (personal project; aa910517@gmail.com)';

const MAX_ANALYSES = Number(process.env.MAX_ANALYSES || 40);
const DRY_RUN = process.env.DRY_RUN === '1';
// 三把免費金鑰任一把有就能運作(與網站 /api/ai 相同的備援策略)
// AI_PROXY_URL 是測試用逃生口（改打網站既有的 /api/ai，它自己有三層免費備援），設了就不需要本機金鑰
if (!process.env.GEMINI_KEY && !process.env.GROQ_KEY && !process.env.OPENROUTER_KEY && !process.env.AI_PROXY_URL && !DRY_RUN) {
  console.error('❌ 未設定任何 AI 金鑰(GEMINI_KEY/GROQ_KEY/OPENROUTER_KEY)，中止（不會嘗試任何付費方案）'); process.exit(1);
}

// ════════════════════════════════════════════════════════════════════════
// ⚠️⚠️ 2026-09-19【人工建置優先】使用者的規則：
//   「如果已經有最新一季法說則不用去跑，且人工建置優先，沒有再跑自動建置」。
//   原本只檢查「自動版是否已是同一季」，完全沒看人工版，實測試跑挑中的第一階段公司裡，
//   光寶科、台光電、研華、TJX 人工版都已是最新一季，卻仍要重做一次 —— 白白浪費每日 40 家名額。
//   現在：人工版（stock_analyzer.html 的 IR_INDEX）已涵蓋這一季（或更新）→ 跳過、不佔名額。
//   人工版看不出季度的（例如「2026（法說會＋月營收）」）視為不知道，照常自動分析，寧可多做不漏做。
//   ⚠️ 前端 stock_analyzer.html 有一模一樣的 parseManualQuarter / compareManualAuto，兩邊要一起改。
// ════════════════════════════════════════════════════════════════════════
// 人工建置的季度標籤 → 可比較的季度。寫法很多種，都要讀得懂：
//   「2026 第二季（2026/07/16）」「2026 上半年」「2026 第一季（無公開法說會…）」→ 日曆季
//   「FY2027 Q1（…Q2將於2026/08/27公布）」「2027 財年第二季」→ 公司自己的會計年度
//   「2026（法說會＋月營收）」這種看不出季度的 → null，一律當作「不知道」，不跳過
function parseManualQuarter(label) {
  const s = String(label || '');
  const qn = x => ({ '一': 1, '二': 2, '三': 3, '四': 4 }[x] || +x);
  let m = s.match(/FY\s*(\d{4})\s*Q\s*([1-4])/i) || s.match(/(\d{4})\s*財年\s*第?\s*([一二三四1-4])\s*季/);
  if (m) return { kind: 'fiscal', y: +m[1], q: qn(m[2]) };
  m = s.match(/(\d{4})\s*年?\s*(?:第\s*([一二三四1-4])\s*季|Q\s*([1-4]))/);
  if (m) return { kind: 'cal', y: +m[1], q: qn(m[2] || m[3]) };
  m = s.match(/(\d{4})\s*年?\s*(上半年|下半年|全年|年度)/);
  if (m) return { kind: 'cal', y: +m[1], q: m[2] === '上半年' ? 2 : 4 };
  return null;
}
// 自動版相對於人工版：'newer'（自動較新）｜'same'（同一季）｜'older'（人工較新）｜'unknown'（無法判斷）
//   台股：兩邊都是日曆季，直接比。
//   美股：自動版是 SEC 的會計年度季別。人工版寫會計年度就直接比；寫日曆季就改比「期間結束日」，
//   容許 45 天誤差（同一季的會計期間結束日與日曆季底本來就會差幾週，例如 NVDA 7/26 vs 6/30）。
function compareManualAuto(manualLabel, auto) {
  const m = parseManualQuarter(manualLabel);
  if (!m || !auto) return 'unknown';
  const tag = String(auto.quarterTag || '');
  const t = tag.match(/^(\d{4})Q?([1-4])$/) || tag.match(/^(\d{4})(FY)$/);
  if (!t) return 'unknown';
  const ay = +t[1], aq = t[2] === 'FY' ? 4 : +t[2];
  const cmp = (a, b) => a > b ? 'newer' : a < b ? 'older' : 'same';
  const isTw = auto.market === 'tw';
  if (isTw || m.kind === 'fiscal') return cmp(ay * 10 + aq, m.y * 10 + m.q);
  const endStr = auto.official && auto.official.periodEnd;
  if (!endStr) return 'unknown';
  const aEnd = new Date(endStr), mEnd = new Date(m.y, m.q * 3, 0);
  const days = (aEnd - mEnd) / 86400000;
  return days > 45 ? 'newer' : days < -45 ? 'older' : 'same';
}
function loadManualIndex() {
  try {
    const html = fs.readFileSync(path.join(ROOT, 'stock_analyzer.html'), 'utf8');
    const i = html.indexOf('const IR_INDEX');
    const line = html.slice(i, html.indexOf('\n', i));
    return new Function('return ' + line.slice(line.indexOf('{'), line.lastIndexOf('}') + 1))();
  } catch (e) { console.log('  ⚠️ 讀不到人工建置索引 IR_INDEX（' + e.message + '），本次不做人工優先判斷'); return {}; }
}
// 美股 ADR → 台股代碼（聯電 UMC→2303、日月光 ASX→3711、中華電 CHT→2412）：
//   這幾家的人工內容建在台股代碼底下，美股代碼查 IR_INDEX 會找不到。
const US_TW_EQUIV = (() => {
  try {
    const html = fs.readFileSync(path.join(ROOT, 'stock_analyzer.html'), 'utf8');
    const i = html.indexOf('const US_TW_EQUIV');
    const st = html.indexOf('{', i), en = html.indexOf('}', st);
    return new Function('return ' + html.slice(st, en + 1))();
  } catch (e) { return {}; }
})();

// 公司官網 IR 頁網址：使用者人工整理的 1,270 筆，正是「抓官網逐字稿」路徑的入口。
//   人工建置的成果在這裡繼續發揮價值——不是白做的。
function loadIrPages() {
  try {
    const html = fs.readFileSync(path.join(ROOT, 'stock_analyzer.html'), 'utf8');
    const i = html.indexOf('const IR_QUARTERLY_PAGE');
    const st = html.indexOf('{', i);
    let d = 0, j = st;
    for (; j < html.length; j++) {
      if (html[j] === '{') d++;
      else if (html[j] === '}') { d--; if (d === 0) { j++; break; } }
    }
    return new Function('return ' + html.slice(st, j))();
  } catch (e) { return {}; }
}
// 雙掛牌對照（2330↔TSM 等）。⚠️ 實測台積電的官網 IR 頁登記在美股代碼 TSM 底下，
//   台股代碼 2330 查 irPages 會是 undefined，於是永遠進不了逐字稿路徑。
//   這是本專案反覆踩到的同一個雙掛牌坑。
function loadTwUsEquiv() {
  try {
    const html = fs.readFileSync(path.join(ROOT, 'stock_analyzer.html'), 'utf8');
    const i = html.indexOf('const TW_US_EQUIV');
    const st = html.indexOf('{', i), en = html.indexOf('}', st);
    return new Function('return ' + html.slice(st, en + 1))();
  } catch (e) { return {}; }
}
const TW_US_EQUIV = loadTwUsEquiv();
// 「使用者最可能在意的公司」名單。⚠️ 不是我另外編的：TW_NAMES 是網站既有的熱門台股
//   中文名字典（239 檔，含 2330／2454／2317／2308…），TICKER_ZH 是美股熱門股中文名，
//   兩份都是專案長期維護、代表「台灣投資人最常交易的標的」。
//   用它當排序第一順位，才不會每輪都把預算花在 1101、1102、1103 這種代碼順序在前的公司。
function loadHotList() {
  try {
    const html = fs.readFileSync(path.join(ROOT, 'stock_analyzer.html'), 'utf8');
    const grab = name => {
      const i = html.indexOf('const ' + name);
      if (i < 0) return {};
      const st = html.indexOf('{', i);
      let d = 0, j = st;
      for (; j < html.length; j++) {
        if (html[j] === '{') d++;
        else if (html[j] === '}') { d--; if (d === 0) { j++; break; } }
      }
      try { return new Function('return ' + html.slice(st, j))(); } catch (e) { return {}; }
    };
    // ⚠️ 必須用「原始碼裡的出現順序」，不能用 Object.keys()。
    //   '2330' 這種純數字字串在 JS 物件裡屬於整數索引鍵，Object.keys() 會由小到大重排，
    //   於是 1101 會跑到 2330 前面 —— 而 TW_NAMES 原始碼是人工「依重要性」排的
    //   （2330 台積電、2317 鴻海、2454 聯發科… 依序），那個順序才是我們要的。
    const seg = name => {
      const i = html.indexOf('const ' + name);
      if (i < 0) return '';
      const st = html.indexOf('{', i);
      let d = 0, j = st;
      for (; j < html.length; j++) {
        if (html[j] === '{') d++;
        else if (html[j] === '}') { d--; if (d === 0) { j++; break; } }
      }
      return html.slice(st, j);
    };
    const order = [];
    for (const m of seg('TW_NAMES').matchAll(/['"](\d{4,6})['"]\s*:/g)) order.push(m[1]);
    const us = grab('ALIASES');   // 中文名→美股代碼，值就是熱門美股代碼
    for (const k in us) if (typeof us[k] === 'string' && !order.includes(us[k])) order.push(us[k]);
    return order;
  } catch (e) { return []; }
}
const HOT_ORDER = loadHotList();
const HOT_IDX = new Map(HOT_ORDER.map((c, i) => [c, i]));
// 取得某一檔的官網 IR 頁：先查自己的代碼，再查雙掛牌對應的美股代碼
function irPageOf(pages, sym) {
  return pages[sym] || (TW_US_EQUIV[sym] ? pages[TW_US_EQUIV[sym]] : null) || null;
}

// 逐字稿路徑每家要多花 15~30 秒，不可能整輪都用。只給「有官網 IR 頁」的公司，
//   且每輪設上限，優先做排在前面（優先序較高）的。其餘退回 SEC 8-K 新聞稿。
const TRANSCRIPT_MAX = Number(process.env.TRANSCRIPT_MAX || 12);

const rocToAd = y => Number(y) + 1911;
const num = v => { const n = Number(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : null; };
const toYiTw = v => { const n = num(v); return n == null ? null : (n / 100000).toFixed(2); };   // 台股原始單位仟元 → 億元
const toYiUs = v => { const n = num(v); return n == null ? null : (n / 1e8).toFixed(2); };      // 美元 → 億美元
const pct = (a, b) => { const x = num(a), y = num(b); return (x != null && y) ? (x / y * 100).toFixed(1) + '%' : '未提供'; };

async function getJson(url, ua) {
  for (let i = 0; i < 3; i++) {
    try { const r = await fetch(url, { headers: { 'User-Agent': ua } }); if (r.ok) return await r.json(); if (r.status === 404) return null; }
    catch (e) {}
    await new Promise(r => setTimeout(r, 1500 * (i + 1)));
  }
  return null;
}

// ── 台股：2 個請求拿到全市場季度損益表 ──
async function loadTwFinancials() {
  const map = {};
  const srcs = [
    { url: 'https://openapi.twse.com.tw/v1/opendata/t187ap06_L_ci', c: '公司代號', n: '公司名稱', y: '年度', s: '季別' },
    { url: 'https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap06_O_ci', c: 'SecuritiesCompanyCode', n: 'CompanyName', y: 'Year', s: 'Season' }
  ];
  for (const src of srcs) {
    const j = await getJson(src.url, UA_TW);
    if (!Array.isArray(j)) { console.warn('⚠️ 台股季度損益表取得失敗:', src.url); continue; }
    for (const r of j) {
      const code = String(r[src.c] || '').trim();
      if (!/^\d{4}$/.test(code)) continue;
      map[code] = {
        market: 'tw', name: r[src.n], year: rocToAd(r[src.y]), season: Number(r[src.s]), currency: '億元（新台幣）',
        營業收入: toYiTw(r['營業收入']), 營業毛利: toYiTw(r['營業毛利（毛損）淨額'] ?? r['營業毛利（毛損）']),
        營業利益: toYiTw(r['營業利益（損失）']), 稅前淨利: toYiTw(r['稅前淨利（淨損）']),
        本期淨利: toYiTw(r['本期淨利（淨損）']),
        // ⚠️ 官方欄位名稱是「淨利（淨損）歸屬於母公司業主」，先前寫錯導致一律抓成 0.00
        母公司業主淨利: toYiTw(r['淨利（淨損）歸屬於母公司業主']),
        每股盈餘: num(r['基本每股盈餘（元）'])
      };
    }
  }
  return map;
}

// ── 美股：SEC XBRL companyfacts，逐家抓最新一季 ──
// 取「期間長度 < 100 天」的區間視為單季（排除半年/全年累計數），再取最新結束日者。
// ⚠️ 必須比較「所有」標籤後取最新，不能「第一個有資料的標籤就採用」。
//    公司會換用不同的 XBRL 標籤：例如 Apple 2019 年起改用
//    RevenueFromContractWithCustomerExcludingAssessedTax，舊的 Revenues 停留在 2018 年。
//    若採第一個有資料者，AAPL 會抓到 2018 年、MSFT 會抓到 2011 年的陳年數字。
function latestQuarterly(facts, tags, unit) {
  let best = null;
  for (const tag of tags) {
    const f = facts[tag];
    if (!f || !f.units || !f.units[unit]) continue;
    for (const x of f.units[unit]) {
      // 10-Q/10-K 是美國本土申報；20-F/40-F/6-K 是外國發行人（如台積電 TSM、ASML）用的表單，
      //   不納入的話這些公司會完全抓不到資料
      if (!x.form || !/^(10-[QK]|20-F|40-F|6-K)$/.test(x.form) || !x.start || !x.end) continue;
      if ((new Date(x.end) - new Date(x.start)) / 86400000 >= 100) continue;   // 排除半年/全年累計數
      if (!best || x.end > best.end) best = x;
    }
  }
  return best;
}

// 外國發行人（台積電 TSM、ASML…）採 IFRS 會計準則，資料放在 ifrs-full 分類法下、
//   標籤名稱與美國本土的 us-gaap 完全不同（Revenue vs Revenues、ProfitLoss vs NetIncomeLoss…）。
//   只讀 us-gaap 的話這些公司會全部抓不到——台積電正是使用者的預設自選股，不能漏。
const TAGS = {
  'us-gaap': {
    rev: ['Revenues', 'RevenueFromContractWithCustomerExcludingAssessedTax',
      'RevenueFromContractWithCustomerIncludingAssessedTax', 'SalesRevenueNet',
      'RevenuesNetOfInterestExpense', 'InterestAndDividendIncomeOperating'],
    gp: ['GrossProfit'], oi: ['OperatingIncomeLoss'], ni: ['NetIncomeLoss', 'ProfitLoss'],
    eps: ['EarningsPerShareDiluted', 'EarningsPerShareBasic'],
    ocf: ['NetCashProvidedByUsedInOperatingActivities'],
    capex: ['PaymentsToAcquirePropertyPlantAndEquipment']
  },
  'ifrs-full': {
    rev: ['Revenue', 'RevenueFromContractsWithCustomers'],
    gp: ['GrossProfit'], oi: ['ProfitLossFromOperatingActivities'],
    ni: ['ProfitLossAttributableToOwnersOfParent', 'ProfitLoss'],
    eps: ['DilutedEarningsLossPerShare', 'BasicEarningsLossPerShare'],
    ocf: ['CashFlowsFromUsedInOperatingActivities'],
    capex: ['PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities']
  }
};

async function loadUsFinancials(cik) {
  const j = await getJson(`https://data.sec.gov/api/xbrl/companyfacts/CIK${String(cik).padStart(10, '0')}.json`, UA_SEC);
  if (!j || !j.facts) return null;
  // 依序試 us-gaap 與 ifrs-full，取哪一個有最新營收就用哪一個
  let g = null, T = null, bestEnd = '';
  for (const tax of ['us-gaap', 'ifrs-full']) {
    if (!j.facts[tax]) continue;
    const probe = latestQuarterly(j.facts[tax], TAGS[tax].rev, 'USD');
    if (probe && probe.end > bestEnd) { bestEnd = probe.end; g = j.facts[tax]; T = TAGS[tax]; }
  }
  if (!g) return null;
  const rev = latestQuarterly(g, T.rev, 'USD');
  if (!rev) return null;
  // 【安全閥】只接受近一年內的期間。若因標籤對應不到而抓到陳年舊值（實測 JPM 原本會抓到 2014 年），
  //   顯示過期數字比不顯示更糟——寧可略過這家公司，也不能拿舊數字當最新財報給使用者看。
  if ((Date.now() - new Date(rev.end)) / 86400000 > 400) return null;
  const gp = latestQuarterly(g, T.gp, 'USD');
  const oi = latestQuarterly(g, T.oi, 'USD');
  const ni = latestQuarterly(g, T.ni, 'USD');
  const eps = latestQuarterly(g, T.eps, 'USD/shares');
  // 自由現金流 = 營運現金流 − 資本支出（兩者官方都有申報時才計算，缺一律不計）
  const ocf = latestQuarterly(g, T.ocf, 'USD');
  const capex = latestQuarterly(g, T.capex, 'USD');
  const sameQ = x => x && x.end === rev.end;   // 只採用與營收同一期間的數字，避免拼接不同季
  return {
    market: 'us', name: j.entityName, currency: '億美元',
    periodStart: rev.start, periodEnd: rev.end,
    year: rev.fy, season: rev.fp, form: rev.form,
    營業收入: toYiUs(rev.val),
    營業毛利: sameQ(gp) ? toYiUs(gp.val) : null,
    營業利益: sameQ(oi) ? toYiUs(oi.val) : null,
    本期淨利: sameQ(ni) ? toYiUs(ni.val) : null,
    每股盈餘: sameQ(eps) ? eps.val : null,
    營運現金流: sameQ(ocf) ? toYiUs(ocf.val) : null,
    資本支出: sameQ(capex) ? toYiUs(capex.val) : null,
    自由現金流: (sameQ(ocf) && sameQ(capex)) ? toYiUs(ocf.val - capex.val) : null
  };
}

// 台股財報依 IFRS 慣例採「累計」編製：第2季＝上半年累計、第3季＝前三季累計、
//   第4季／全年＝全年累計，只有第1季等於單季。回傳這一季在中文裡該怎麼稱呼，
//   以及是不是累計數（供提示詞與欄位標籤共用，確保兩處講法一致不矛盾）。
function twSeasonLabel(season) {
  if (season === 1) return { label: '第1季（單季）', cum: false };
  if (season === 2) return { label: '上半年（累計）', cum: true };
  if (season === 3) return { label: '前三季（累計）', cum: true };
  return { label: '全年（累計）', cum: true };
}

// ── 金額單位：一律由程式換算，不讓 AI 做算術 ────────────────────────
// ⚠️⚠️ 2026-10-10 實測（台積電 2Q26 官網文件、法說會優先通道）：AI 把
//   「NT$1,270.38 billion」寫成「1,270.38 億新台幣」、「US$40.20 billion」寫成「40.20 億美元」，
//   財測「US$44.6～45.8 billion」寫成「44.6～45.8 億美元」—— 全部少 10 倍。
//   提示詞裡早就寫了「billion＝十億」的規則，照樣出錯：這種事不能靠 AI 自律。
//   作法：① 提示詞要求 AI 金額一律照抄原文寫法（NT$1,270.38 billion），不准自己換算；
//         ② 這裡把輸出裡所有「幣別＋數字＋billion/million/trillion」換成中文金額（純算術，不會錯）；
//         ③ 再抓漏網的：AI 仍自己寫了「N 億」，而 N 剛好等於原文某個 billion 數字 → 就是少 10 倍，更正並記錄。
function zhMoney(curRaw, numStr, unitRaw) {
  const n = parseFloat(String(numStr).replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  const u = String(unitRaw).toLowerCase();
  const yi = /^(trillion|tn)$/.test(u) ? n * 10000 : /^(billion|bn|b)$/.test(u) ? n * 10 : /^(million|mn|m)$/.test(u) ? n / 100 : null;   // 換成「億」
  if (yi == null) return null;
  const c = String(curRaw || '').toUpperCase().replace(/\s/g, '');
  const cur = /NT|TWD/.test(c) ? ['新台幣 ', '元'] : /US|^\$$/.test(c) ? ['', '美元'] : /€|EUR/.test(c) ? ['', '歐元'] : /¥|JPY/.test(c) ? ['', '日圓'] : /RMB|CNY/.test(c) ? ['人民幣 ', '元'] : /HK/.test(c) ? ['', '港元'] : null;
  if (!cur) return null;
  const fmt = (x, d) => { const r = Math.round(x * 10 ** d) / 10 ** d; return r.toLocaleString('en-US', { maximumFractionDigits: d }); };
  let body;
  if (yi >= 10000) { const zhao = Math.floor(yi / 10000), rest = yi - zhao * 10000; body = zhao.toLocaleString('en-US') + ' 兆' + (rest >= 0.005 ? ' ' + fmt(rest, 2) + ' 億' : ''); }
  else if (yi >= 1) body = fmt(yi, 2) + ' 億';
  else body = fmt(yi * 10000, 0) + ' 萬';
  return cur[0] + body + cur[1];
}
const MONEY_RE = /(NT\s?\$|NTD|TWD|US\s?\$|USD|HK\s?\$|RMB|CNY|EUR|JPY|€|¥|\$)\s?([\d,]+(?:\.\d+)?)\s?(trillion|billion|million|bn|mn)(?![A-Za-z])/gi;
// 把一段文字裡的英文金額換成中文金額；回傳 [新文字, 換了幾處]
function convertMoney(text) {
  let n = 0;
  const out = String(text).replace(MONEY_RE, (m0, cur, num, unit) => { const z = zhMoney(cur, num, unit); if (!z) return m0; n++; return z; });
  return [out, n];
}
// 抓「少 10 倍」：AI 自己寫的「N 億」，N 剛好等於原文某個 billion 數字（而 N÷10 不是）→ 更正為 N×10
function fixBillionSlip(text, sourceBillions) {
  let n = 0;
  const out = String(text).replace(/([\d,]+(?:\.\d+)?)(\s?)億/g, (m0, num, sp) => {
    const v = parseFloat(num.replace(/,/g, ''));
    if (!Number.isFinite(v) || !sourceBillions.has(v) || sourceBillions.has(Math.round(v / 10 * 1e6) / 1e6)) return m0;
    n++;
    const fixed = Math.round(v * 10 * 100) / 100;
    return (fixed >= 10000 ? Math.floor(fixed / 10000).toLocaleString('en-US') + ' 兆 ' + (fixed % 10000).toLocaleString('en-US', { maximumFractionDigits: 2 }) : fixed.toLocaleString('en-US', { maximumFractionDigits: 2 })) + sp + '億';
  });
  return [out, n];
}
// ── 數字查核：AI 寫的每一個數字都必須在官方原文裡找得到 ─────────────
// ⚠️⚠️ 2026-10-10 實測（台積電 2Q26）：AI 寫出「處分世界先進股份貢獻每股盈餘 2.75 元」，
//   官網兩份文件裡只有 2.24，根本沒有 2.75 —— 是 AI 自己編的。
//   使用者的鐵則是「以事實為依據，絕不臆測」「寧可留白也不能寫錯」，這不能只靠提示詞要求。
//   作法：把原文裡出現過的數字全部收集起來；AI 的輸出逐條檢查，
//   只要某一條裡有「原文找不到的數字」，整條刪掉（條列刪那一點，段落刪那一句）。
//   · 不檢查：個位數整數（第 2 季、3 奈米這類幾乎一定在原文）、年份、季別代號（2Q26）、產品代號（N2、A16）
//   · 12.0 與 12、40.20 與 40.2 視為相同
//   代價是偶爾會多刪一條其實沒錯的（例如 AI 把 95.83 寫成 95.8）—— 可以接受，錯的數字不行。
function numTokens(text) {
  const t = String(text || '').replace(/[1-4]Q\d{2}(?!\d)/gi, ' ').replace(/(?<![A-Za-z])[A-Z]\d{1,2}[A-Z]?(?![A-Za-z0-9])/g, ' ');
  const out = [];
  for (const m of t.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const v = parseFloat(m[0].replace(/,/g, ''));
    if (!Number.isFinite(v)) continue;
    if (Number.isInteger(v) && v < 10) continue;                     // 個位數不查
    if (Number.isInteger(v) && v >= 1990 && v <= 2035) continue;     // 年份不查
    out.push(v);
  }
  return out;
}
function groundNumbers(result, sourceText) {
  if (!result || typeof result !== 'object') return { result, dropped: 0, examples: [] };
  const src = new Set(numTokens(sourceText));
  let dropped = 0; const examples = [];
  const bad = s => numTokens(s).filter(v => !src.has(v));
  const outObj = {};
  for (const [k, v] of Object.entries(result)) {
    if (typeof v !== 'string' || k.startsWith('__') || /^(未提供|未揭露)[。.]?$/.test(v.trim())) { outObj[k] = v; continue; }
    const isList = /<br\s*\/?>/i.test(v) || /^\s*•/.test(v);
    const parts = isList ? v.split(/<br\s*\/?>/i) : v.split(/(?<=[。！？])/);
    const keep = [];
    for (const part of parts) {
      if (!part.trim()) continue;
      const b = bad(part);
      if (b.length) { dropped++; if (examples.length < 5) examples.push(k + '：原文找不到 ' + b.slice(0, 3).join('、') + ' →「' + part.replace(/\s+/g, ' ').trim().slice(0, 60) + '…」'); }
      else keep.push(part);
    }
    outObj[k] = keep.length ? keep.join(isList ? '<br>' : '') : '未提供';
  }
  return { result: outObj, dropped, examples };
}

// 對 AI 回傳的整份結果做金額正規化。excerpt＝餵給 AI 的官方文件原文。
function normalizeMoney(result, excerpt) {
  if (!result || typeof result !== 'object') return { result, converted: 0, fixed: 0 };
  const src = new Set();
  for (const m of String(excerpt || '').matchAll(/([\d,]+(?:\.\d+)?)\s?(?:billion|bn)(?![A-Za-z])/gi)) { const v = parseFloat(m[1].replace(/,/g, '')); if (Number.isFinite(v)) src.add(v); }
  // 原文裡「數字 → 幣別」的對照（前綴寫法 US$40.2 billion／USD60 billion，或後綴寫法 96 billion NT dollars）
  const curOf = new Map();
  const note = (num, cur) => { const v = parseFloat(String(num).replace(/,/g, '')); if (!Number.isFinite(v)) return; const c = /NT|TWD/i.test(cur) ? 'NT$' : 'US$'; curOf.set(v, curOf.has(v) && curOf.get(v) !== c ? '?' : c); };
  for (const m of String(excerpt || '').matchAll(/(NT\s?\$|NTD|TWD|US\s?\$|USD)\s?([\d,]+(?:\.\d+)?)\s?(?:trillion|billion|million)/gi)) note(m[2], m[1]);
  // 單獨一個 $（前面沒有 NT／US／HK 等字母）在這些文件裡指美元：台積電等台廠寫新台幣一律用 NT$
  for (const m of String(excerpt || '').matchAll(/(?<![A-Za-z])\$\s?([\d,]+(?:\.\d+)?)\s?(?:trillion|billion|million)/gi)) note(m[1], 'US$');
  for (const m of String(excerpt || '').matchAll(/([\d,]+(?:\.\d+)?)\s?(?:trillion|billion|million)\s+(NT|US|U\.S\.)\s?dollars/gi)) note(m[1], m[2]);
  const bare = t => t.replace(/(?<![\d$A-Za-z.])([\d,]+(?:\.\d+)?)\s?(trillion|billion|million)(?![A-Za-z])(?:\s+(NT|US|U\.S\.)\s?dollars)?/gi, (m0, num, unit, suf) => {
    const v = parseFloat(num.replace(/,/g, ''));
    const c = suf ? (/NT/i.test(suf) ? 'NT$' : 'US$') : curOf.get(v);
    if (c && c !== '?') { const z = zhMoney(c, num, unit); if (z) { converted++; return z; } }
    const z = zhMoney('US$', num, unit); if (!z) return m0;
    converted++; return z.replace(/美元$/, '') + '（原文未註明幣別）';
  });
  let converted = 0, fixed = 0;
  const outObj = {};
  for (const [k, v] of Object.entries(result)) {
    if (typeof v !== 'string' || k.startsWith('__')) { outObj[k] = v; continue; }
    let [t, a] = convertMoney(v); converted += a;
    t = bare(t);
    let b = 0; if (src.size) { [t, b] = fixBillionSlip(t, src); fixed += b; }
    outObj[k] = t;
  }
  return { result: outObj, converted, fixed };
}

// ── 法說會優先通道的提示詞 ──
//   與一般提示詞的輸出欄位完全相同（前端不用改），差別只在「數字從哪來」。
function buildPromptIrFirst(symbol, f, pr, irQ) {
  const isTw = f.market === 'tw';
  const srcLabel = pr.kind === 'transcript' ? '公司法說會逐字稿與同季官方文件節錄' : '公司法說會當季官方文件節錄（管理報告／財報新聞稿／簡報）';
  return `你是專業的財報分析師。以下是${isTw ? '台股' : '美股'} ${f.name}（代碼 ${symbol}）${irQ.y} 年第 ${irQ.q} 季法說會的官方文件節錄，
來源為公司官網投資人關係專區（原文未經改寫）。
⚠️ 這一季的數字，交易所／SEC 的結構化資料庫此時尚未公布，所以沒有另外提供官方數字表。

【${srcLabel}】
${pr.excerpt}

【鐵則 — 務必嚴格遵守】
1. 所有財務數字「只能」使用上方文件節錄中明確出現的數字，嚴禁自行推算、臆測或用你的訓練記憶補充。
   文件裡沒有的項目一律寫「未提供」，寧可留白也不能寫錯。
2. ⚠️ 【只有「金額」這幾個字】照抄原文的寫法，例如「NT$1,270.38 billion」「US$40.20 billion」「US$632 million」，
   【絕對不要】自己換算成「億」「兆」「十億」—— 換算由程式負責，你一換算就可能差 10 倍。
   · 表格裡的數字若單位寫在表頭（例如表頭「In NT$ billions」、數字「1,270.38」），請補成完整寫法「NT$1,270.38 billion」。
   · 原文口語省略幣別時（例如逐字稿說「63 billion」），請依上下文補上幣別，寫成「NT$63 billion」或「US$63 billion」。
   · 每股盈餘（EPS）請寫成「27.25 元」或「1.05 美元」；百分比、天數照常寫。NT$ 與 US$ 不可混用、不可自行換匯。
3. ⚠️ 除了上面第 2 點的金額寫法以外，【所有內容一律翻成通順的繁體中文】，不可以把英文原句或英文單字直接留在句子裡
   （錯誤示範：「本季 net revenue 為…」「gross margin 提高」「partially offset by…」；正確：「本季營收為…」「毛利率提高」「部分被…抵銷」）。
   只有公司名、人名、產品與製程代號（如 N2、A16、CoWoS、HPC）可以保留英文。管理層發言也要翻成中文，不要整句貼英文。
4. 若某項數字為負值，要明確指出是虧損或衰退，不可用修辭包裝。
5. 不得預測股價、不得給目標價；「未來展望／財測」只能寫公司自己在文件中說的，不可自行預測。
6. 只寫這一季（${irQ.y} 年第 ${irQ.q} 季）與公司對未來的官方說法，不要把文件中「去年同期」「上一季」的數字誤寫成本季。

只回傳 JSON，不要任何其他文字、不要 markdown：
{
 "revenue":"本季營收（引用文件原文數字，含季增／年增），1-2句",
 "eps":"本季每股盈餘 EPS（引用文件原文數字），1-2句",
 "margins":"本季毛利率／營業利益率／淨利率與變動原因（只引用文件有寫的），2-3句",
 "fcf":"自由現金流或營運現金流（文件未提供則寫「未提供」）",
 "capex":"本季資本支出（文件未提供則寫「未提供」）",
 "guidance":"公司對下一季或全年的財測摘要（文件未提供則寫「未提供」）",
 "outlook":"管理層對需求與產業的看法，2-3句（只寫文件有的）",
 "highlights":"本季亮點 3 點，每點以•開頭、<br>分行，都要有文件中的數字",
 "concerns":"須留意之處 2-3 點，每點以•開頭、<br>分行（只寫文件有提到的）",
 "risks":"文件提到的風險 1-3 點，每點以•開頭、<br>分行；沒有就寫「未提供」",
 "keyPoints":"投資人最該知道的 3 點，每點以•開頭、<br>分行",
 "guidanceOfficial":"公司對『下一季或全年』的官方展望／財測，忠實翻成繁體中文並保留所有數字與單位；文件未提供則寫「未提供」",
 "segments":"各製程／平台／部門／產品別的營收占比與增減，每項以•開頭、<br>分行；文件未提供則寫「未提供」",
 "mgmtRemarks":"${pr.kind === 'transcript' ? '從逐字稿萃取管理層親口說過、投資人最該知道的關鍵發言 3-5 點，每點以•開頭、<br>分行，可註明發言者；必須是原文出現過的內容' : '這份文件不是逐字稿，沒有管理層口頭發言，請一律寫「未提供」'}",
 "capexPlan":"資本支出／產能擴充計畫（金額、年度、用途），保留原文數字；沒有提到就寫「未提供」",
 "techRoadmap":"技術／產品路線圖 3-5 點，每點以•開頭、<br>分行，保留製程或產品世代名稱與具體時程；沒有提到就寫「未提供」"
}`;
}

// ── 提示詞 ──
// pr = 公司自己發布的財報新聞稿節錄（僅美股有；台股的 OpenAPI 只有數字沒有文字說明）
function buildPrompt(symbol, f, pr, irQ) {
  // irQ（法說會優先通道）：公司官網已經有新一季的法說會文件，但交易所／SEC 的結構化數字還沒換季。
  //   這時【不可以】把上一季的官方數字餵給 AI，否則會寫出「第三季營收＝第二季的數字」。
  //   改為只給文件原文，並明講所有數字只能出自文件。
  if (irQ) return buildPromptIrFirst(symbol, f, pr, irQ);
  const isTw = f.market === 'tw';
  const twSeason = isTw ? twSeasonLabel(f.season) : null;
  const period = isTw ? `${f.year} 年${twSeason.label}`
    : `會計年度 ${f.year} ${f.season}（期間 ${f.periodStart} ～ ${f.periodEnd}，申報表單 ${f.form}）`;
  const src = isTw ? '臺灣證券交易所／證券櫃檯買賣中心公開資訊（政府官方開放資料）'
    : '美國證券交易委員會（SEC）EDGAR XBRL 官方申報資料';
  const lines = [
    isTw && twSeason.cum ? `⚠️ 以下數字是「${twSeason.label}」的累計數字，不是單一季度的數字，你的分析與用詞都必須反映這是累計期間，禁止寫成「本季」或暗示這是三個月的表現。` : null,
    `營業收入：${f.營業收入 ?? '未提供'}`,
    `營業毛利：${f.營業毛利 ?? '未提供'}（毛利率 ${pct(f.營業毛利, f.營業收入)}）`,
    `營業利益：${f.營業利益 ?? '未提供'}（營業利益率 ${pct(f.營業利益, f.營業收入)}）`,
    isTw ? `稅前淨利：${f.稅前淨利 ?? '未提供'}` : null,
    `本期淨利：${f.本期淨利 ?? '未提供'}（淨利率 ${pct(f.本期淨利, f.營業收入)}）`,
    isTw ? `淨利歸屬母公司業主：${f.母公司業主淨利 ?? '未提供'}` : null,
    !isTw ? `營運現金流：${f.營運現金流 ?? '未提供'}` : null,
    !isTw ? `資本支出：${f.資本支出 ?? '未提供'}` : null,
    !isTw ? `自由現金流（營運現金流 − 資本支出）：${f.自由現金流 ?? '未提供'}` : null,
    `每股盈餘（EPS）：${f.每股盈餘 ?? '未提供'} ${isTw ? '元' : '美元'}`
  ].filter(Boolean).join('\n');

  // 有新聞稿時，額外要求萃取「官方展望」與「分部／產品別營收」——這兩樣是數字 API 沒有的，
  //   但公司自己寫在新聞稿裡，屬於官方原文，不是臆測。
  const srcLabel = !pr ? '' :
    pr.kind === 'transcript' ? '公司法說會逐字稿節錄（來自公司官網投資人關係專區，原文未經改寫）' :
    pr.kind === 'irdoc' ? '公司官網投資人關係文件節錄（原文未經改寫）' :
    pr.kind === 'deck' ? `公司法人說明會簡報節錄（${pr.filedAt} 上傳至公開資訊觀測站，原文未經改寫）` :
    `公司官方財報新聞稿節錄（${pr.filedAt} 向 SEC 申報的 ${pr.form}，原文未經改寫）`;
  const prBlock = pr ? `

【${srcLabel}】
${pr.excerpt}
` : '';
  const prFields = pr ? `,
 "guidanceOfficial":"從上方${pr.kind==='deck'?'法說會簡報':'新聞稿'}節錄中，找出公司對『下一季或全年』的官方展望／財測，忠實翻成繁體中文並保留所有數字與單位（例如「第三季營收預期 1,080 億美元，正負 2%；毛利率預期 74.0%，正負 50 個基點」）。這必須是原文裡實際出現的文字，嚴禁自行推算或補充。若原文沒有提供展望（例如 Apple 不公布書面財測），寫「公司未於本次資料提供財測」。",
 "segments":"從上方${pr.kind==='deck'?'法說會簡報':'原文'}節錄中，整理各部門／產品別的營收與增減（例如「資料中心：890 億美元，季增 18%、年增 117%」），每項以•開頭、<br>分行。只能列出原文實際提到的部門與數字，嚴禁自行分類或估算佔比。若原文未揭露分部數字，寫「本次資料未揭露分部營收」。"${pr.kind === 'transcript' ? `,
 "__unitRule":"⚠️⚠️ 單位換算鐵則（違反會讓數字差 10 倍，是最嚴重的錯誤）：英文 billion＝十億，所以 US$100 billion 必須寫成「1,000 億美元」不是「100 億美元」；US$60 billion 是「600 億美元」。million＝百萬，US$15.7 billion 是「157 億美元」。若無把握，直接保留原文寫法「US$100B」，不要自行換算成中文數字。",
 "mgmtRemarks":"這份是完整法說會逐字稿，請萃取『管理層親口說過、且投資人最該知道』的關鍵發言 3-5 點，每點以•開頭、<br>分行。要求：①必須是原文出現過的內容，可註明是誰說的（例如「執行長表示…」）②優先選：對未來需求的看法、財測是否上修或下修、產能與資本支出計畫、對競爭或風險的說法 ③保留原文的具體數字與措辭強度（例如「比之前更強」「需求極為強勁」不可淡化成「表現良好」）④嚴禁把分析師的提問寫成公司的說法。若逐字稿中找不到明確的管理層前瞻發言，寫「逐字稿未包含明確前瞻發言」。",
 "capexPlan":"從逐字稿中整理資本支出／產能擴充計畫（金額、年度、用途配置），保留原文數字。沒有提到就寫「未提供」。",
 "techRoadmap":"⚠️ 從逐字稿中整理『技術／產品路線圖』3-5 點，每點以•開頭、<br>分行。要求：①保留製程或產品世代名稱與具體規格（例如「A14 較 N2 速度提升 10~15%、功耗改善 25~30%、密度提升近 20%」）②保留時程（風險試產／量產是哪一年）③保留產能佈局（在哪些地點各增建幾座廠）。這一段是人工整理版本最有價值的內容，務必不要漏。沒有提到就寫「本次未提及技術路線圖」。"` : ''}` : '';

  return `你是專業的財報分析師。以下是${isTw ? '台股' : '美股'} ${f.name}（代碼 ${symbol}）${period}的官方財務數字，
來源為${src}。

【官方數字（金額單位：${f.currency}）】
${lines}${prBlock}

【鐵則 — 務必嚴格遵守】
1. 所有財務數字「只能」使用上方提供的官方數字，嚴禁自行推算、臆測或用你的訓練記憶補充。
2. 上方標示「未提供」的項目，你也必須寫「未提供」，絕對不可以編造。這是最重要的一條，
   寧可留白也不能寫錯。財測、法說會 Q&A、管理層發言若上方沒有提供，一律寫「未提供」。
3. 一律使用繁體中文。金額沿用上方單位（${f.currency}），不要自行換算成其他幣別。
4. 若某項數字為負值，要明確指出是虧損，不可用成長率或修辭包裝
   （例如「虧損收斂」不等於「轉盈」，必須講清楚仍在虧損）。
5. 不得預測股價、不得給目標價、不得預測未來營收數字。

只回傳 JSON，不要任何其他文字、不要 markdown：
{
 "revenue":"營收表現，引用官方數字，1-2句",
 "eps":"EPS 表現，引用官方數字，1-2句",
 "margins":"毛利率／營業利益率／淨利率的水準與意涵，引用上方算出的百分比，2-3句",
 "fcf":"自由現金流狀況（若上方未提供則寫「未提供」）",
 "capex":"資本支出狀況（若上方未提供則寫「未提供」）",
 "guidance":"${pr ? '官方財測／展望的一句話摘要（詳細內容放在 guidanceOfficial 欄位）' : '官方財測／展望（本次無法說會簡報或新聞稿可依據，請寫「未提供」）'}",
 "outlook":"僅根據上方數字可合理說明的營運狀況，不得預測，2-3句",
 "highlights":"${isTw && twSeason.cum ? '這段累計期間' : '本季'}主要亮點2-3點，每點以•開頭、<br>分行，只能根據上方數字",
 "concerns":"${isTw && twSeason.cum ? '這段累計期間' : '本季'}須留意之處2-3點，每點以•開頭、<br>分行，只能根據上方數字",
 "risks":"從財務結構可觀察到的風險2點，<br>分行",
 "keyPoints":"投資人最需要注意的3件事，<br>分行，須引用實際數字"${prFields}
}`;
}

// 改用共用的三層備援模組（原本只用 Gemini、沒有備援，額度用完就整個停止）
async function callGemini(prompt) {
  const r = await callAI(prompt);
  if (r) return { result: r };
  return shouldStop() ? { rateLimited: true } : { failed: true };
}


// ── 主流程 ──
const qPath = path.join(ROOT, 'data', 'events', 'queue.json');
if (!fs.existsSync(qPath)) { console.error('❌ 找不到 data/events/queue.json，請先執行 detect-events.mjs'); process.exit(1); }
const { queue } = JSON.parse(fs.readFileSync(qPath, 'utf8'));

fs.mkdirSync(OUT_DIR, { recursive: true });
const rank = { HIGH: 0, MEDIUM: 1, LOW: 2 };
// 依優先序排序後，「兩個市場交錯」取用。
//   ⚠️ 原本只依優先序排，而有法說會事件的台股全是 HIGH、美股是 MEDIUM，
//   結果每天的預算會先被 63 家台股吃光，美股永遠輪不到（實測第二次執行 3 家全是台股）。
//   改為在同一優先層內台股／美股輪流，確保兩邊每天都有進度。
//   注意：必須「跨優先層」交錯，不能只在同一層內交錯。因為有法說會事件的台股全在 HIGH、
//   美股全在 MEDIUM，若只在層內交錯，仍要先做完 63 家 HIGH 台股才輪得到美股（實測仍是 12:0）。
//   作法：兩個市場各自依優先序排好，再一左一右交替取用，兩邊都能每天有進度。
const twFin = await loadTwFinancials();
console.log(`  已載入台股官方季度財務 ${Object.keys(twFin).length} 家`);

// 美股需要 CIK 才能查 SEC，先取對照表
// 台股法說會簡報索引（近 4 個月，一次抓好供整輪使用）
const twCalls = await fetchCallIndex(4);
console.log(`  已載入台股法說會簡報索引 ${twCalls.size} 家`);

const irPages = loadIrPages();
console.log(`  已載入公司官網 IR 頁 ${Object.keys(irPages).length} 家（逐字稿路徑入口）`);

// ⚠️⚠️ 排序必須放在載入 IR 頁「之後」，因為第一順位鍵就是「這家公司有沒有官網 IR 頁」。
//   實測問題：佇列 1,910 家裡有 1,908 家是 LOW（多為沒有法說會的中小型股），
//   而排序只看優先序時，這些小公司會依代碼順序（1101、1102、1103…）先被處理，
//   每輪 MAX_ANALYSES=40 家的預算全部用在它們身上。
//   台積電 2330 排在第 315 位 —— 永遠輪不到，逐字稿路徑因此一次都沒真正跑過
//   （實測 64 份自動摘要中，帶管理層原話的：0 份）。
//   使用者的目標是「達到人工建置的品質」，而品質差異就來自逐字稿，
//   所以「拿得到官網逐字稿的公司」必須排在最前面。
const hasIr = x => irPageOf(irPages, x.symbol) ? 0 : 1;
// 熱門股名次：數字越小越重要（TW_NAMES 原始碼順序）；不在名單內給一個很大的數字排到後面
const hotIdx = x => {
  const a = HOT_IDX.has(x.symbol) ? HOT_IDX.get(x.symbol) : null;
  const b = TW_US_EQUIV[x.symbol] && HOT_IDX.has(TW_US_EQUIV[x.symbol]) ? HOT_IDX.get(TW_US_EQUIV[x.symbol]) : null;
  const v = (a == null) ? b : (b == null ? a : Math.min(a, b));
  return v == null ? 99999 : v;
};
// 排序三層：①使用者最在意的熱門股 ②拿得到官網逐字稿 ③原本的事件優先序。
//   ⚠️ 只用「有沒有 IR 頁」排不夠：684 家都有 IR 頁，同層之間仍照代碼順序，
//   實測台積電還是排第 260 位，每輪 40 家仍然輪不到（改版前是第 315 位）。
// ════════════════════════════════════════════════════════════════════════
// ⚠️⚠️ 2026-09-19 使用者指定的名額分配順序（最外層排序鍵）：
//   ① 使用者主動點過的公司（最近 3 天，來自網站 /api/demand 的匿名統計）
//   ② 第一階段 → ③ 第二階段 → ④ 第三階段 → ⑤ 第四階段 → ⑥ 第五階段 → ⑦ 其他
//   使用者原話：「如果每天的使用者去點的不到 40 間，則依照我的五階段公司去更新」。
//   已經是最新一季的公司會在下面的迴圈被跳過、不佔 40 家名額，所以前面的階段更新完，
//   名額自然流到後面的階段。同一層內仍沿用原本的三層排序（熱門股 → 有官網 IR 頁 → 事件優先度），
//   並讓台股、美股交錯，兩邊每天都有進度。
//   實測改版前：THFF、UPXI 這類不在任何階段的美國小型股每天都在吃名額，現在排到最後。
// ════════════════════════════════════════════════════════════════════════
const normSym = s => String(s || '').trim().toUpperCase().replace(/\./g, '-');
const stageOf = (() => {
  const m = new Map();
  try {
    const st = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'stages', 'stages.json'), 'utf8')).stages;
    for (const [k, arr] of Object.entries(st)) for (const s of arr) m.set(normSym(s), Number(k));
    console.log('  已載入五階段名單 ' + m.size + ' 家');
  } catch (e) { console.log('  ⚠️ 讀不到 data/stages/stages.json，本次不分階段（' + e.message + '）'); }
  return x => m.get(normSym(x.symbol)) || 6;
})();
const demand = await (async () => {
  try {
    const r = await fetch((process.env.SITE_URL || 'https://weicheng-stock.pages.dev') + '/api/demand?days=3',
      { signal: AbortSignal.timeout(15000) });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || ('HTTP ' + r.status));
    console.log('  使用者最近 3 天查看過 ' + j.symbols.length + ' 家（排最前面）');
    return new Set(j.symbols.map(normSym));
  } catch (e) { console.log('  ⚠️ 取不到使用者查看紀錄，本次只依五階段排序（' + e.message + '）'); return new Set(); }
})();
// 使用者點過、但佇列裡沒有的公司（沒有偵測到新事件）也補進來：
//   下面的迴圈會檢查「官方資料是否比現有摘要新」，沒有新資料就會自動跳過、不佔名額。
for (const s of demand) {
  if (!queue.some(x => normSym(x.symbol) === s)) {
    queue.push({ market: /^\d{4,6}[A-Z]?$/.test(s) ? 'tw' : 'us', symbol: s, name: s, reasons: ['使用者查看'], priority: 'LOW' });
  }
}
const tierOf = x => demand.has(normSym(x.symbol)) ? 0 : stageOf(x);
const within = (a, b) => (hotIdx(a) - hotIdx(b)) || (hasIr(a) - hasIr(b)) || (rank[a.priority] - rank[b.priority]);
const sorted = [];
for (let t = 0; t <= 6; t++) {
  const inTier = queue.filter(x => tierOf(x) === t);
  const twQ = inTier.filter(x => x.market === 'tw').sort(within);
  const usQ = inTier.filter(x => x.market !== 'tw').sort(within);
  for (let i = 0; i < Math.max(twQ.length, usQ.length); i++) {
    if (i < twQ.length) sorted.push(twQ[i]);
    if (i < usQ.length) sorted.push(usQ[i]);
  }
}
{
  let st = {}; try { st = JSON.parse(fs.readFileSync(process.env.IR_STATE_PATH ? path.resolve(process.env.IR_STATE_PATH) : path.join(ROOT, 'data', 'events', 'ir-checks.json'), 'utf8')) || {}; } catch (e) {}
  const inQ = new Set(sorted.map(x => x.symbol));
  const pend = Object.entries(st).filter(([s, v]) => v && v.pending && !inQ.has(s)
    && (Date.now() - new Date(v.pendingSince || 0).getTime()) / 86400000 <= 45);
  for (const [s, v] of pend) sorted.unshift({ market: v.market, symbol: s, name: v.name || s, reasons: ['等待法說會逐字稿'], eventDate: '', priority: 'HIGH', _pending: true });
  if (pend.length) console.log('  等待逐字稿升級：' + pend.map(([s]) => s).join('、') + '（已排到最前面）');
}
const tierCount = [0, 1, 2, 3, 4, 5, 6].map(t => queue.filter(x => tierOf(x) === t).length);
console.log('  名額分配順序：使用者點過 ' + tierCount[0] + ' → 第1階段 ' + tierCount[1] + ' → 第2階段 ' + tierCount[2] +
  ' → 第3階段 ' + tierCount[3] + ' → 第4階段 ' + tierCount[4] + ' → 第5階段 ' + tierCount[5] + ' → 其他 ' + tierCount[6]);
const irCount = queue.filter(x => !hasIr(x)).length, hotCount = queue.filter(x => hotIdx(x) < 99999).length;
console.log(`▶ 佇列 ${sorted.length} 家（熱門股 ${hotCount} 家、有官網 IR 頁 ${irCount} 家，已依序排到最前面），本次上限 ${MAX_ANALYSES} 家`);

const tickMap = await getJson('https://www.sec.gov/files/company_tickers.json', UA_SEC);
const tk2cik = new Map();
for (const v of Object.values(tickMap || {})) tk2cik.set(v.ticker, v.cik_str);
console.log(`  已載入美股代碼→CIK 對照 ${tk2cik.size} 家`);

let done = 0, skipped = 0, failed = 0, stoppedByQuota = false, usedTranscript = 0, manualCovered = 0;

// ── 時間預算 ──────────────────────────────────────────────────────
// ⚠️⚠️ 2026-10-10 發現：最近 6 天有 5 天整個排程被 GitHub「取消」。
//   原因是 workflow 設了 50 分鐘上限，而這一步常常跑到 49 分鐘 —— 一超時整個工作被強制中止，
//   後面的「提交結果」被跳過，當天已經分析好、寫在硬碟上的 30 幾家【全部沒存進 repo】。
//   解法：自己看時間，快到上限就優雅收工（做完手上這一家就停），讓提交那一步有機會執行。
const T0 = Date.now();
const TIME_BUDGET_MS = Number(process.env.TIME_BUDGET_MIN || 34) * 60000;
let stoppedByTime = false;

// ── 法說會優先通道 ────────────────────────────────────────────────
// 使用者 2026-10-10 要求：「以後法說會到，自動抓取公司官方網頁來源抓取法說會內容，
//   希望可以做到現在的台積電法說內容一樣」（台積電 10/15 法說會）。
// 原本的流程是等「交易所／SEC 的財報數字」換季才動作。但法說會當天官網就有新一季的文件，
//   交易所的數字卻要再等幾週（台股季報期限是季後 45 天）—— 於是法說會開完，程式判定
//   「跟已經做過的是同一季」而跳過，要等到下個月才會更新。
// 現在：公司有新的法說會／財報事件時，就算交易所數字還沒換季，也去官網看一眼；
//   官網文件標示的季別「剛好比手上的新一季」，就直接用官網文件產生這一季的內容。
//   · 當天只有管理報告／新聞稿／簡報 → 先用這些產生（沒有管理層原話）
//   · 之後逐字稿上傳（台積電約晚三週）→ 自動重做一次，升級成含管理層原話的版本
// 每家公司什麼時候看過、看到哪一季、是不是還在等逐字稿，記在 data/events/ir-checks.json。
const IR_STATE_PATH = process.env.IR_STATE_PATH ? path.resolve(process.env.IR_STATE_PATH) : path.join(ROOT, 'data', 'events', 'ir-checks.json');
let irState = {}; try { irState = JSON.parse(fs.readFileSync(IR_STATE_PATH, 'utf8')) || {}; } catch (e) { irState = {}; }
// 【測試用，正式排程不會設定】法說會優先通道平常要等公司真的開法說會才測得到，所以留兩個模擬開關：
//   ONLY_SYMBOLS="2330"                 只處理這幾家（逗號分隔）
//   IR_TEST='{"2330":{"url":"…","shift":1}}'  這家改抓指定的官網頁，並假裝「手上已做到的季別」少 shift 季
//   搭配 OUT_DIR 指到暫存資料夾，就能用上一季的真實官網頁，完整演練「新一季文件出現」的情境而不動到正式資料。
const ONLY_SYMBOLS = new Set(String(process.env.ONLY_SYMBOLS || '').split(',').map(s => s.trim()).filter(Boolean));
let IR_TEST = {}; try { IR_TEST = JSON.parse(process.env.IR_TEST || '{}') || {}; } catch (e) { IR_TEST = {}; }
const IR_CHECK_MAX = Number(process.env.IR_CHECK_MAX || 15);   // 每輪最多「去官網看一眼」幾家（每家約 10～20 秒）
const PENDING_DAYS = 45;                                        // 等逐字稿最多等幾天
let irChecks = 0, irFirstDone = 0, irUpgraded = 0;
const qKeyOfTag = tag => { const m = String(tag || '').match(/^(\d{4})Q?([1-4])$/) || String(tag || '').match(/^(\d{4})(FY)$/); return m ? (+m[1]) * 4 + (m[2] === 'FY' ? 4 : +m[2]) : 0; };
const eventIso = d => { const s = String(d || ''); if (/^\d{7}$/.test(s)) return (+s.slice(0, 3) + 1911) + '-' + s.slice(3, 5) + '-' + s.slice(5, 7); if (/^\d{8}$/.test(s)) return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8); return ''; };
const daysSince = iso => iso ? (Date.now() - new Date(iso).getTime()) / 86400000 : 9999;
// 這家公司現在需不需要去官網看一眼
function irDue(item) {
  const st = irState[item.symbol];
  if (!st) return true;                                              // 從來沒看過
  const ev = eventIso(item.eventDate);
  if (ev && ev > String(st.at || '').slice(0, 10)) return true;      // 上次看過之後又有新的法說會／財報事件
  if (st.pending && daysSince(st.at) >= 3 && daysSince(st.pendingSince) <= PENDING_DAYS) return true;   // 還在等逐字稿，每 3 天看一次
  return false;
}
const MANUAL_INDEX = loadManualIndex();
console.log('  已載入人工建置季度索引 ' + Object.keys(MANUAL_INDEX).length + ' 家（人工版已是最新一季者不自動做）');
const stat = { tw: 0, us: 0 };

for (const item of sorted) {
  if (done >= MAX_ANALYSES) { console.log(`⏸ 已達本次上限 ${MAX_ANALYSES} 家，其餘留待下次執行`); break; }
  if (ONLY_SYMBOLS.size && !ONLY_SYMBOLS.has(item.symbol)) continue;
  if (Date.now() - T0 > TIME_BUDGET_MS) { stoppedByTime = true; console.log(`⏱ 已執行 ${Math.round((Date.now() - T0) / 60000)} 分鐘，達到時間預算，先收工讓結果能提交；其餘留待下次執行`); break; }

  let f = null;
  if (item.market === 'tw') {
    f = twFin[item.symbol];
  } else {
    const cik = tk2cik.get(item.symbol);
    if (!cik) { skipped++; continue; }
    f = await loadUsFinancials(cik);
    await new Promise(r => setTimeout(r, 250));   // 遵守 SEC 存取頻率規範
  }
  // 營收為 0 或空白者略過：這類多是尚無實質營運的空殼／早期公司（實測 iBio、FIRST BREACH
  //   等營收 0.00 億、EPS 空白）。對它們做分析只會產出沒有內容的文字，還白白消耗免費額度，
  //   應該把額度留給真正有營運的公司。
  if (!f || f.營業收入 == null || Number(f.營業收入) <= 0) { skipped++; continue; }

  // 季度識別：同一家公司同一季只分析一次
  const qTag = f.market === 'tw' ? `${f.year}Q${f.season}` : `${f.year}${f.season}`;
  const out = path.join(OUT_DIR, `${item.symbol}.json`);
  let prev = null;
  if (fs.existsSync(out)) { try { prev = JSON.parse(fs.readFileSync(out, 'utf8')); } catch (e) {} }
  const regKey = qKeyOfTag(qTag);                         // 交易所／SEC 目前公布到哪一季
  const prevKey = prev ? qKeyOfTag(prev.quarterTag) : 0;  // 我們手上已經做到哪一季
  // ★ 人工建置優先：人工版已是這一季（或更新）就不自動做。雙掛牌（2330↔TSM、2303↔UMC…）兩邊都查。
  let manualCover = false, manualKey = 0;
  {
    const alias = [item.symbol, TW_US_EQUIV[item.symbol], US_TW_EQUIV[item.symbol],
      ...Object.keys(TW_US_EQUIV).filter(k => TW_US_EQUIV[k] === item.symbol),
      ...Object.keys(US_TW_EQUIV).filter(k => US_TW_EQUIV[k] === item.symbol)].filter(Boolean);
    const mLabel = alias.map(s => MANUAL_INDEX[s]).find(Boolean);
    const rel = mLabel ? compareManualAuto(mLabel, { market: f.market, quarterTag: qTag, official: { periodEnd: f.periodEnd } }) : 'unknown';
    manualCover = (rel === 'same' || rel === 'older');
    const mq = mLabel ? parseManualQuarter(mLabel) : null;
    // 人工版的季別只有在「跟自動版同一種算法」時才能拿來比大小（台股都是日曆季；美股要人工版寫的是會計年度）
    if (mq && (f.market === 'tw' || mq.kind === 'fiscal')) manualKey = mq.y * 4 + mq.q;
  }

  const irT = IR_TEST[item.symbol] || null;
  const irUrl = (irT && irT.url) || irPageOf(irPages, item.symbol);
  // 雙掛牌時 IR 頁登記在美股代碼底下（2330 的頁在 TSM），要用登記的那個代碼去抓
  const irSym = irPages[item.symbol] ? item.symbol : (TW_US_EQUIV[item.symbol] || item.symbol);
  let pr = null, doc = null, irQ = null, upgrade = false;
  const nothingNewOfficially = (prev && prevKey >= regKey) || manualCover;   // 依交易所的數字，這家沒有新東西

  if (nothingNewOfficially) {
    // 一般情況到這裡就跳過。例外：法說會剛開完，官網可能已經有新一季的文件（見上方「法說會優先通道」）
    if (!irUrl || irChecks >= IR_CHECK_MAX || !irDue(item)) { skipped++; if (manualCover) manualCovered++; continue; }
    irChecks++;
    doc = await fetchIrDocument(irSym, irUrl);
    const haveKey = Math.max(regKey, prevKey, manualKey) - (irT ? (irT.shift || 0) : 0);
    const dq = doc && doc.quarter;
    const st = irState[item.symbol] || {};
    irState[item.symbol] = { ...st, at: new Date().toISOString(), market: item.market, name: f.name,
      seen: dq ? (dq.y + 'Q' + dq.q) : (doc ? '季別不明' : '沒有文件'), kind: doc ? doc.kind : '' };
    if (dq && dq.key === haveKey + 1) {
      irQ = dq;                                                    // 官網有「剛好新一季」的文件 → 用它產生
    } else if (dq && prev && prev.irFirst && dq.key === prevKey && prev.docKind !== 'transcript' && doc.kind === 'transcript') {
      irQ = dq; upgrade = true;                                    // 同一季，逐字稿終於上傳了 → 升級
    } else {
      if (st.pending && daysSince(st.pendingSince) > PENDING_DAYS) irState[item.symbol].pending = false;   // 等太久，不等了
      skipped++; if (manualCover) manualCovered++; continue;
    }
    usedTranscript++;
    console.log(`     ↳ 官網已有 ${irQ.y} 年第 ${irQ.q} 季文件（${doc.docs.map(d => d.kind).join('＋')}），交易所數字尚未換季 → ${upgrade ? '逐字稿已上傳，升級內容' : '走法說會優先通道'}`);
  } else if (usedTranscript < TRANSCRIPT_MAX && irUrl) {
    // ⚠️⚠️ 官網逐字稿是「達到人工建置品質」的唯一來源（管理層原話與問答都在裡面）。
    //   不分市場，只要查得到官網 IR 頁就先試；取不到才走各自市場的備援。
    doc = await fetchIrDocument(irSym, irUrl);
    if (doc) {
      usedTranscript++;
      const dq = doc.quarter;
      if (dq && dq.key === regKey + 1 && dq.key > prevKey && dq.key > manualKey) {
        irQ = dq;   // 官網文件比交易所數字新一季 → 不可以把上一季的官方數字跟這一季的文件混在一起
        console.log(`     ↳ 官網文件是 ${dq.y} 年第 ${dq.q} 季，比交易所數字新一季 → 走法說會優先通道`);
      } else if (dq && dq.key !== regKey) {
        // 官網文件的季別跟官方數字對不上（多半是官網還停在上一季）→ 這份文件不用，改走備援，避免張冠李戴
        console.log(`     ↳ 官網文件是 ${dq.y}Q${dq.q}，與官方數字的季別（${qTag}）不同，不採用`);
        doc = null;
      } else {
        console.log(`     ↳ 官網${doc.kind === 'transcript' ? '逐字稿' : '文件'}（${doc.docs.map(d => d.kind + ' ' + d.text.length + '字').join('＋')}）`);
      }
    }
  }
  if (doc) {
    const isTr = doc.kind === 'transcript';
    pr = { kind: isTr ? 'transcript' : 'irdoc', filedAt: '', form: isTr ? '法說會逐字稿' : '法說會官方文件（管理報告／簡報／新聞稿）',
      url: doc.url, excerpt: focusExcerptDocs(doc.docs) };
  }
  if (!pr && item.market === 'tw') {
    // 台股備援：法說會簡報 PDF（MOPS）。小型公司多半沒開法說會，取不到屬正常
    const info = twCalls.get(item.symbol);
    if (info) {
      const txt = await fetchCallPdfText(info.pdf);
      if (txt) pr = { kind: 'deck', filedAt: info.date, form: '法說會簡報', url: `https://mopsov.twse.com.tw/nas/STR/${info.pdf}`, excerpt: focusExcerptTw(txt) };
      await new Promise(r => setTimeout(r, 400));
    }
  } else if (!pr) {
    // 美股備援：SEC 8-K 財報新聞稿（可靠度接近 100%，但沒有問答內容）
    const raw = await fetchLatestEarningsRelease(tk2cik.get(item.symbol));
    if (raw) pr = { kind: 'press', filedAt: raw.filedAt, form: raw.form, url: raw.url, excerpt: focusExcerpt(raw.text) };
    await new Promise(r => setTimeout(r, 250));
  }

  const prompt = buildPrompt(item.symbol, f, pr, irQ);
  if (DRY_RUN) {
    console.log(`  [DRY] ${item.market.toUpperCase()} ${item.symbol} ${f.name} ${qTag} 營收${f.營業收入} EPS ${f.每股盈餘}${pr ? ' ｜' + ({transcript:'逐字稿 ',irdoc:'官網文件 ',deck:'法說簡報 ',press:'新聞稿 '}[pr.kind]||'') + pr.excerpt.length + '字' : ' ｜無簡報/新聞稿'}`);
    if (irQ) console.log(`        ↳ [DRY] 法說會優先通道：${irQ.y}Q${irQ.q}${upgrade ? '（逐字稿升級）' : ''}，提示詞 ${prompt.length} 字`);
    done++; stat[item.market]++; continue;
  }

  const r = await callGemini(prompt);
  if (r.rateLimited) {
    console.log('⏹ Gemini 免費額度已用盡，本次停止（不會切換到任何付費模式）');
    stoppedByQuota = true; break;
  }
  if (r.failed || !r.result) { failed++; console.log(`  ✗ ${item.symbol} ${f.name} 分析失敗`); continue; }
  if (pr) {
    const g = groundNumbers(r.result, pr.excerpt + (irQ ? '' : '\n' + prompt));
    if (irQ) {
      r.result = g.result;
      if (g.dropped) console.log(`     ↳ 數字查核：刪除 ${g.dropped} 條含「原文找不到的數字」的內容｜` + g.examples.join('｜'));
    } else if (g.dropped) {
      console.log(`     ↳ 數字查核（僅記錄，未刪除）：${g.dropped} 條含原文／官方數字以外的數字｜` + g.examples.slice(0, 2).join('｜'));
    }
    const nm = normalizeMoney(r.result, pr.excerpt);
    r.result = nm.result;
    if (nm.converted || nm.fixed) console.log(`     ↳ 金額正規化：程式換算 ${nm.converted} 處${nm.fixed ? '、更正少 10 倍 ' + nm.fixed + ' 處' : ''}`);
  }

  if (irQ) {
    // 法說會優先通道：季別以官網文件為準；官方結構化數字還沒有，official 只放識別資訊（不可放上一季的數字）
    const qEnd = new Date(Date.UTC(irQ.y, irQ.q * 3, 0)).toISOString().slice(0, 10);
    fs.writeFileSync(out, JSON.stringify({
      symbol: item.symbol, market: f.market, name: f.name,
      quarter: `${irQ.y} 第${irQ.q}季`, quarterTag: `${irQ.y}Q${irQ.q}`,
      irFirst: true, docKind: doc.kind,
      source: '公司官網投資人關係文件（交易所／SEC 的結構化財報數字此時尚未公布）',
      official: { market: f.market, name: f.name, currency: '', irFirst: true, ...(f.market === 'tw' ? { periodEnd: qEnd } : {}) },
      pressRelease: { filedAt: '', form: pr.form, url: pr.url },
      savedAt: new Date().toISOString(), result: r.result
    }, null, 1));
    const st = irState[item.symbol] || {};
    const waiting = doc.kind !== 'transcript';
    irState[item.symbol] = { ...st, at: new Date().toISOString(), market: item.market, name: f.name,
      done: irQ.y + 'Q' + irQ.q, kind: doc.kind, pending: waiting, pendingSince: waiting ? (st.pending && st.pendingSince ? st.pendingSince : new Date().toISOString()) : '' };
    if (upgrade) irUpgraded++; else irFirstDone++;
    done++; stat[item.market]++;
    console.log(`  ✓ ${item.market.toUpperCase()} ${item.symbol} ${f.name} ${irQ.y}Q${irQ.q}（法說會優先通道${upgrade ? '·逐字稿升級' : waiting ? '·等逐字稿' : ''}）`);
    await new Promise(r => setTimeout(r, 7000));
    continue;
  }
  fs.writeFileSync(out, JSON.stringify({
    symbol: item.symbol, market: f.market, name: f.name,
    quarter: f.market === 'tw' ? `${f.year} ${twSeasonLabel(f.season).label}` : `${f.year} ${f.season}（${f.periodStart}～${f.periodEnd}）`,
    quarterTag: qTag,
    source: f.market === 'tw' ? '臺灣證券交易所／櫃買中心 公開資訊 OpenAPI（官方）' : 'SEC EDGAR XBRL 官方申報資料',
    official: f,
    pressRelease: pr ? { filedAt: pr.filedAt, form: pr.form, url: pr.url } : null,
    docKind: doc ? doc.kind : '',
    savedAt: new Date().toISOString(), result: r.result
  }, null, 1));
  done++; stat[item.market]++;
  console.log(`  ✓ ${item.market.toUpperCase()} ${item.symbol} ${f.name} ${qTag}`);

  // 免費層每分鐘約 10 次上限。7 秒 ≒ 每分鐘 8.5 次，留安全餘裕
  //   （首次執行用 4.5 秒 ≒ 每分鐘 13 次，在第 10 家就觸發 429 提前停止）
  await new Promise(r => setTimeout(r, 7000));
}

await closeBrowser();
try { fs.writeFileSync(IR_STATE_PATH, JSON.stringify(irState, null, 1)); } catch (e) { console.log('⚠️ 無法寫入 ir-checks.json：' + e.message); }
console.log(`   法說會優先通道：去官網看了 ${irChecks} 家，新一季 ${irFirstDone} 家、逐字稿升級 ${irUpgraded} 家；還在等逐字稿 ${Object.values(irState).filter(v => v && v.pending).length} 家`);
if (stoppedByTime) console.log('   （本次因時間預算提前收工，結果已寫入，其餘明天繼續）');
console.log(`   AI 來源：Gemini ${aiStats.gemini}／Groq ${aiStats.groq}／OpenRouter ${aiStats.openrouter}`);
console.log(`✅ 完成：新分析 ${done} 家（台股 ${stat.tw}、美股 ${stat.us}）、略過 ${skipped} 家、失敗 ${failed} 家${stoppedByQuota ? '（因免費額度用盡提前結束）' : ''}`);
console.log('   其中「人工版已是最新一季」而略過：' + manualCovered + ' 家（人工建置優先）');
console.log(`   其中 ${usedTranscript} 家使用了公司官網逐字稿／文件（品質最高的來源）`);
