// 最新財報 AI 分析 —— 消費 detect-events.mjs 產生的佇列（台股 + 美股）
//
// 【設計原則】
// 1. Gemini 只負責「分析已經取得的官方數字」，絕不讓它去搜尋公司（那是 detect-events 的工作）。
// 2. 同一家公司、同一季只分析一次：輸出檔已存在且季度相同就跳過。
// 3. 依優先序 HIGH → MEDIUM → LOW，額度用完就停，HIGH 永遠先做。
// 4. 【零費用鐵則】只用 Gemini 免費層。免費層超額的行為是「拒絕請求(429)」而不是「開始收費」，
//    只要那個 Google Cloud 專案「永遠不要啟用帳單(billing)」，就不可能產生任何費用。
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

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT_DIR = path.join(ROOT, 'data', 'earnings');
const UA_TW = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const UA_SEC = 'StockAnalyzer/1.0 (personal project; aa910517@gmail.com)';

const MAX_ANALYSES = Number(process.env.MAX_ANALYSES || 40);
const DRY_RUN = process.env.DRY_RUN === '1';
const KEY = process.env.GEMINI_KEY;
if (!KEY && !DRY_RUN) { console.error('❌ 未設定 GEMINI_KEY，中止（不會嘗試任何付費替代方案）'); process.exit(1); }

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

// ── 提示詞 ──
function buildPrompt(symbol, f) {
  const isTw = f.market === 'tw';
  const period = isTw ? `${f.year} 年第 ${f.season} 季`
    : `會計年度 ${f.year} ${f.season}（期間 ${f.periodStart} ～ ${f.periodEnd}，申報表單 ${f.form}）`;
  const src = isTw ? '臺灣證券交易所／證券櫃檯買賣中心公開資訊（政府官方開放資料）'
    : '美國證券交易委員會（SEC）EDGAR XBRL 官方申報資料';
  const lines = [
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

  return `你是專業的財報分析師。以下是${isTw ? '台股' : '美股'} ${f.name}（代碼 ${symbol}）${period}的官方財務數字，
來源為${src}。

【官方數字（金額單位：${f.currency}）】
${lines}

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
 "guidance":"官方財測／展望（本資料未含法說會內容，請寫「未提供」）",
 "outlook":"僅根據上方數字可合理說明的營運狀況，不得預測，2-3句",
 "highlights":"本季主要亮點2-3點，每點以•開頭、<br>分行，只能根據上方數字",
 "concerns":"本季須留意之處2-3點，每點以•開頭、<br>分行，只能根據上方數字",
 "risks":"從財務結構可觀察到的風險2點，<br>分行",
 "keyPoints":"投資人最需要注意的3件事，<br>分行，須引用實際數字"
}`;
}

async function callGemini(prompt) {
  // 只用免費層可用的 Flash 系列。Pro 已於 2026 年 4 月移出免費層，不可使用。
  for (const model of ['gemini-3.5-flash', 'gemini-3.1-flash-lite']) {
    try {
      const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 60000);
      const r = await fetch('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', {
        method: 'POST', signal: ctl.signal,
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + KEY },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], temperature: 0.3 })
      });
      clearTimeout(to);
      if (r.status === 429) return { rateLimited: true };   // 免費額度用盡 → 停止，絕不改用付費
      if (!r.ok) continue;
      const j = await r.json();
      const m = (j?.choices?.[0]?.message?.content || '').match(/\{[\s\S]*\}/);
      if (m) { try { return { result: JSON.parse(m[0]) }; } catch (e) {} }
    } catch (e) {}
  }
  return { failed: true };
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
const byRank = m => queue.filter(x => (m === 'tw' ? x.market === 'tw' : x.market !== 'tw'))
  .sort((a, b) => rank[a.priority] - rank[b.priority]);
const twQ = byRank('tw'), usQ = byRank('us');
const sorted = [];
for (let i = 0; i < Math.max(twQ.length, usQ.length); i++) {
  if (i < twQ.length) sorted.push(twQ[i]);
  if (i < usQ.length) sorted.push(usQ[i]);
}
console.log(`▶ 佇列 ${sorted.length} 家，本次上限 ${MAX_ANALYSES} 家（台股／美股交錯處理）`);

const twFin = await loadTwFinancials();
console.log(`  已載入台股官方季度財務 ${Object.keys(twFin).length} 家`);

// 美股需要 CIK 才能查 SEC，先取對照表
const tickMap = await getJson('https://www.sec.gov/files/company_tickers.json', UA_SEC);
const tk2cik = new Map();
for (const v of Object.values(tickMap || {})) tk2cik.set(v.ticker, v.cik_str);
console.log(`  已載入美股代碼→CIK 對照 ${tk2cik.size} 家`);

let done = 0, skipped = 0, failed = 0, stoppedByQuota = false;
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

  const prompt = buildPrompt(item.symbol, f);
  if (DRY_RUN) {
    console.log(`  [DRY] ${item.market.toUpperCase()} ${item.symbol} ${f.name} ${qTag} 營收${f.營業收入} EPS ${f.每股盈餘}`);
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
    quarter: f.market === 'tw' ? `${f.year} 第${f.season}季` : `${f.year} ${f.season}（${f.periodStart}～${f.periodEnd}）`,
    quarterTag: qTag,
    source: f.market === 'tw' ? '臺灣證券交易所／櫃買中心 公開資訊 OpenAPI（官方）' : 'SEC EDGAR XBRL 官方申報資料',
    official: f, savedAt: new Date().toISOString(), result: r.result
  }, null, 1));
  done++; stat[item.market]++;
  console.log(`  ✓ ${item.market.toUpperCase()} ${item.symbol} ${f.name} ${qTag}`);

  // 免費層每分鐘約 10 次上限。7 秒 ≒ 每分鐘 8.5 次，留安全餘裕
  //   （首次執行用 4.5 秒 ≒ 每分鐘 13 次，在第 10 家就觸發 429 提前停止）
  await new Promise(r => setTimeout(r, 7000));
}

console.log(`✅ 完成：新分析 ${done} 家（台股 ${stat.tw}、美股 ${stat.us}）、略過 ${skipped} 家、失敗 ${failed} 家${stoppedByQuota ? '（因免費額度用盡提前結束）' : ''}`);
