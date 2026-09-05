// 最新財報 AI 分析 —— 消費 detect-events.mjs 產生的佇列（台股 + 美股）
//
// 【設計原則】
// 1. Gemini 只負責「分析已經取得的官方數字」，絕不讓它去搜尋公司（那是 detect-events 的工作）。
// 2. 同一家公司、同一季只分析一次：輸出檔已存在且季度相同就跳過。
// 3. 依優先序 HIGH → MEDIUM → LOW，額度用完就停，HIGH 永遠先做。
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
import { fetchIrDocument, focusExcerptIr, closeBrowser } from './lib/ir-transcript.mjs';
// 三層備援(Gemini→Groq→OpenRouter)，與網站 /api/ai 行為一致
import { callAI, aiStats, shouldStop } from './lib/ai-call.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT_DIR = path.join(ROOT, 'data', 'earnings');
const UA_TW = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const UA_SEC = 'StockAnalyzer/1.0 (personal project; aa910517@gmail.com)';

const MAX_ANALYSES = Number(process.env.MAX_ANALYSES || 40);
const DRY_RUN = process.env.DRY_RUN === '1';
// 三把免費金鑰任一把有就能運作(與網站 /api/ai 相同的備援策略)
// AI_PROXY_URL 是測試用逃生口（改打網站既有的 /api/ai，它自己有三層免費備援），設了就不需要本機金鑰
if (!process.env.GEMINI_KEY && !process.env.GROQ_KEY && !process.env.OPENROUTER_KEY && !process.env.AI_PROXY_URL && !DRY_RUN) {
  console.error('❌ 未設定任何 AI 金鑰(GEMINI_KEY/GROQ_KEY/OPENROUTER_KEY)，中止（不會嘗試任何付費方案）'); process.exit(1);
}

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

// ── 提示詞 ──
// pr = 公司自己發布的財報新聞稿節錄（僅美股有；台股的 OpenAPI 只有數字沒有文字說明）
function buildPrompt(symbol, f, pr) {
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
const byRank = m => queue.filter(x => (m === 'tw' ? x.market === 'tw' : x.market !== 'tw'))
  .sort((a, b) => (hotIdx(a) - hotIdx(b)) || (hasIr(a) - hasIr(b)) || (rank[a.priority] - rank[b.priority]));
const twQ = byRank('tw'), usQ = byRank('us');
const sorted = [];
for (let i = 0; i < Math.max(twQ.length, usQ.length); i++) {
  if (i < twQ.length) sorted.push(twQ[i]);
  if (i < usQ.length) sorted.push(usQ[i]);
}
const irCount = queue.filter(x => !hasIr(x)).length, hotCount = queue.filter(x => hotIdx(x) < 99999).length;
console.log(`▶ 佇列 ${sorted.length} 家（熱門股 ${hotCount} 家、有官網 IR 頁 ${irCount} 家，已依序排到最前面），本次上限 ${MAX_ANALYSES} 家`);

const tickMap = await getJson('https://www.sec.gov/files/company_tickers.json', UA_SEC);
const tk2cik = new Map();
for (const v of Object.values(tickMap || {})) tk2cik.set(v.ticker, v.cik_str);
console.log(`  已載入美股代碼→CIK 對照 ${tk2cik.size} 家`);

let done = 0, skipped = 0, failed = 0, stoppedByQuota = false, usedTranscript = 0;
const stat = { tw: 0, us: 0 };

for (const item of sorted) {
  if (done >= MAX_ANALYSES) { console.log(`⏸ 已達本次上限 ${MAX_ANALYSES} 家，其餘留待下次執行`); break; }

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
  if (fs.existsSync(out)) {
    try {
      const prev = JSON.parse(fs.readFileSync(out, 'utf8'));
      if (prev.quarterTag === qTag) { skipped++; continue; }   // ★ 已是同一季，跳過
    } catch (e) {}
  }

  // 美股額外抓公司自己發布的財報新聞稿：官方展望與分部營收都寫在裡面，
  //   這兩樣是純數字 API 給不了、但又最有價值的內容。
  let pr = null;
  // ⚠️⚠️ 官網逐字稿是「達到人工建置品質」的唯一來源（管理層原話與問答都在裡面）。
  //   原本這段寫在下面的 else 分支裡，等於「只有美股會走逐字稿路徑」，台股一律只拿
  //   MOPS 法說會簡報。這是 64 份自動摘要中 0 份有管理層原話的主因之一。
  //   改為：不分市場，只要查得到官網 IR 頁就先試逐字稿；取不到才走各自市場的備援。
  const irUrl = irPageOf(irPages, item.symbol);
  if (usedTranscript < TRANSCRIPT_MAX && irUrl) {
    // 雙掛牌時 IR 頁登記在美股代碼底下（2330 的頁在 TSM），要用登記的那個代碼去抓
    const irSym = irPages[item.symbol] ? item.symbol : (TW_US_EQUIV[item.symbol] || item.symbol);
    const doc = await fetchIrDocument(irSym, irUrl);
    if (doc) {
      usedTranscript++;
      pr = { kind: doc.kind === 'transcript' ? 'transcript' : 'irdoc', filedAt: '', form: doc.kind === 'transcript' ? '法說會逐字稿' : '公司官網文件', url: doc.url, excerpt: focusExcerptIr(doc.text) };
      console.log(`     ↳ 官網${doc.kind === 'transcript' ? '逐字稿' : '文件'} ${doc.text.length} 字`);
    }
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

  const prompt = buildPrompt(item.symbol, f, pr);
  if (DRY_RUN) {
    console.log(`  [DRY] ${item.market.toUpperCase()} ${item.symbol} ${f.name} ${qTag} 營收${f.營業收入} EPS ${f.每股盈餘}${pr ? ' ｜' + ({transcript:'逐字稿 ',irdoc:'官網文件 ',deck:'法說簡報 ',press:'新聞稿 '}[pr.kind]||'') + pr.excerpt.length + '字' : ' ｜無簡報/新聞稿'}`);
    done++; stat[item.market]++; continue;
  }

  const r = await callGemini(prompt);
  if (r.rateLimited) {
    console.log('⏹ Gemini 免費額度已用盡，本次停止（不會切換到任何付費模式）');
    stoppedByQuota = true; break;
  }
  if (r.failed || !r.result) { failed++; console.log(`  ✗ ${item.symbol} ${f.name} 分析失敗`); continue; }

  fs.writeFileSync(out, JSON.stringify({
    symbol: item.symbol, market: f.market, name: f.name,
    quarter: f.market === 'tw' ? `${f.year} ${twSeasonLabel(f.season).label}` : `${f.year} ${f.season}（${f.periodStart}～${f.periodEnd}）`,
    quarterTag: qTag,
    source: f.market === 'tw' ? '臺灣證券交易所／櫃買中心 公開資訊 OpenAPI（官方）' : 'SEC EDGAR XBRL 官方申報資料',
    official: f,
    pressRelease: pr ? { filedAt: pr.filedAt, form: pr.form, url: pr.url } : null,
    savedAt: new Date().toISOString(), result: r.result
  }, null, 1));
  done++; stat[item.market]++;
  console.log(`  ✓ ${item.market.toUpperCase()} ${item.symbol} ${f.name} ${qTag}`);

  // 免費層每分鐘約 10 次上限。7 秒 ≒ 每分鐘 8.5 次，留安全餘裕
  //   （首次執行用 4.5 秒 ≒ 每分鐘 13 次，在第 10 家就觸發 429 提前停止）
  await new Promise(r => setTimeout(r, 7000));
}

await closeBrowser();
console.log(`   AI 來源：Gemini ${aiStats.gemini}／Groq ${aiStats.groq}／OpenRouter ${aiStats.openrouter}`);
console.log(`✅ 完成：新分析 ${done} 家（台股 ${stat.tw}、美股 ${stat.us}）、略過 ${skipped} 家、失敗 ${failed} 家${stoppedByQuota ? '（因免費額度用盡提前結束）' : ''}`);
console.log(`   其中 ${usedTranscript} 家使用了公司官網逐字稿／文件（品質最高的來源）`);
