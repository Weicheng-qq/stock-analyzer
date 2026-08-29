// 事件偵測 —— 取代「每天逐家掃描 5,000~6,000 家公司」的做法
//
// 【核心觀念】
// 不去問「這 6000 家公司誰有新資料？」（那要 6000 次請求），
// 而是問「今天全市場有哪些新申報？」（一天只要幾個請求），再從中挑出我們追蹤的公司。
//
// 【實測可用的免費官方端點（2026-08-29 全部驗證過 HTTP 200）】
//   美股 SEC   https://www.sec.gov/Archives/edgar/daily-index/{年}/QTR{季}/form.{YYYYMMDD}.idx
//              一天一個檔（約1.4MB）就涵蓋全市場所有申報，實測 8/28 有 8-K 174筆、10-Q 17筆、6-K 99筆
//   美股 SEC   https://www.sec.gov/files/company_tickers.json          CIK→股票代碼對照
//   台股 上市  https://openapi.twse.com.tw/v1/opendata/t187ap04_L      每日重大訊息（含法說會公告）
//   台股 上市  https://openapi.twse.com.tw/v1/opendata/t187ap06_L_ci   全部上市公司季度損益表（1035家）
//   台股 上櫃  https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap04_O   上櫃每日重大訊息
//   台股 上櫃  https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap06_O_ci 全部上櫃公司季度損益表（874家）
//
// ⚠️ 重要更正：交接記錄長期記載「TWSE 官方 API 全被 403 擋」，實測發現 openapi.twse.com.tw
//    完全可用。先前的 403 應該是從 Vercel 機房 IP 呼叫時被擋，從 GitHub Actions 呼叫沒問題。
//    這也再次印證交接記錄第 6.19 條的教訓：不要把單一情境的失敗推論成整個來源不可用。
//
// 【輸出】data/events/queue.json —— 只包含「真的有新事件」的公司，供後續分析步驟處理。

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const UA_SEC = 'StockAnalyzer/1.0 (personal project; aa910517@gmail.com)';
const UA_TW = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

// 我們關心的申報類型：都是「可能包含最新財報/法說會內容」的
const US_FORMS = new Set(['8-K', '10-Q', '10-K', '6-K', '20-F', '40-F']);

async function getText(url, ua, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': ua, 'Accept': '*/*' } });
      if (r.ok) return await r.text();
      // 429/5xx 才重試，4xx 直接放棄（重試也不會變好，還浪費對方資源）
      if (r.status < 500 && r.status !== 429) return null;
    } catch (e) { /* 網路瞬斷，往下重試 */ }
    await new Promise(r => setTimeout(r, 1500 * (i + 1)));
  }
  return null;
}
const getJson = async (url, ua) => { const t = await getText(url, ua); if (!t) return null; try { return JSON.parse(t); } catch { return null; } };

// 民國年 → 西元年（台股官方資料一律用民國年，如 115 = 2026）
const rocToAd = y => Number(y) + 1911;

// ── 讀出目前站上已有的資料狀態（IR_CALL_SUMMARY 就是我們的「已知最新季度」）──
function loadCurrentState() {
  const html = fs.readFileSync(path.join(ROOT, 'stock_analyzer.html'), 'utf8');
  const i = html.indexOf('const IR_CALL_SUMMARY');
  const st = html.indexOf('{', i);
  let d = 0, j = st;
  for (; j < html.length; j++) {
    if (html[j] === '{') d++;
    else if (html[j] === '}') { d--; if (d === 0) { j++; break; } }
  }
  const obj = new Function('return ' + html.slice(st, j))();
  const state = {};
  for (const [k, v] of Object.entries(obj)) state[k] = (v && v.quarter) || '';
  return state;
}

// ── 美股：從 SEC 每日索引找出有新申報的公司 ──
async function detectUS(days) {
  const tickMap = await getJson('https://www.sec.gov/files/company_tickers.json', UA_SEC);
  if (!tickMap) { console.warn('⚠️ 無法取得 SEC CIK→ticker 對照表，跳過美股偵測'); return []; }
  const cik2tk = new Map();
  for (const v of Object.values(tickMap)) cik2tk.set(String(v.cik_str), v.ticker);

  const found = new Map();   // ticker → {forms:Set, date}
  for (let back = 0; back < days; back++) {
    const dt = new Date(Date.now() - back * 86400000);
    const y = dt.getUTCFullYear();
    const q = Math.floor(dt.getUTCMonth() / 3) + 1;
    const ymd = `${y}${String(dt.getUTCMonth() + 1).padStart(2, '0')}${String(dt.getUTCDate()).padStart(2, '0')}`;
    const txt = await getText(`https://www.sec.gov/Archives/edgar/daily-index/${y}/QTR${q}/form.${ymd}.idx`, UA_SEC);
    if (!txt) continue;   // 週末/假日沒有檔案，屬正常
    let n = 0;
    for (const line of txt.split('\n')) {
      // 固定寬度格式：表單類型 / 公司名 / CIK / 日期 / 檔名
      const m = line.match(/^(\S+)\s{2,}.+?\s{2,}(\d+)\s+(\d{8})\s+(\S+)\s*$/);
      if (!m) continue;
      if (!US_FORMS.has(m[1])) continue;
      const tk = cik2tk.get(String(Number(m[2])));
      if (!tk) continue;                       // 沒有股票代碼的申報者（基金/個人）不處理
      const cur = found.get(tk) || { forms: new Set(), date: m[3] };
      cur.forms.add(m[1]);
      if (m[3] > cur.date) cur.date = m[3];
      found.set(tk, cur);
      n++;
    }
    console.log(`  SEC ${ymd}: 命中 ${n} 筆我們關心的申報`);
    await new Promise(r => setTimeout(r, 400));   // 尊重 SEC 的存取頻率規範
  }
  return [...found].map(([ticker, v]) => ({
    market: 'us', symbol: ticker, forms: [...v.forms], eventDate: v.date, reason: 'SEC 新申報'
  }));
}

// ── 台股：每日重大訊息（法說會）＋ 季度損益表（新季別出現代表新財報）──
async function detectTW() {
  const out = new Map();
  const add = (code, name, reason, eventDate) => {
    if (!/^\d{4}$/.test(code || '')) return;
    const cur = out.get(code) || { market: 'tw', symbol: code, name, reasons: [], eventDate: eventDate || '' };
    if (!cur.reasons.includes(reason)) cur.reasons.push(reason);
    if (eventDate && eventDate > cur.eventDate) cur.eventDate = eventDate;
    out.set(code, cur);
  };

  const srcs = [
    { url: 'https://openapi.twse.com.tw/v1/opendata/t187ap04_L', code: '公司代號', name: '公司名稱', mkt: '上市' },
    { url: 'https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap04_O', code: 'SecuritiesCompanyCode', name: 'CompanyName', mkt: '上櫃' }
  ];
  for (const s of srcs) {
    const j = await getJson(s.url, UA_TW);
    if (!j || !Array.isArray(j)) { console.warn(`⚠️ ${s.mkt}每日重大訊息取得失敗`); continue; }
    let hit = 0;
    for (const r of j) {
      const blob = JSON.stringify(r);
      // 只挑跟法說會/財務報告有關的重大訊息，其餘（更名、董事異動…）不觸發重新分析
      if (!/法人說明會|法說會|說明會|財務報告|財務預測|自結/.test(blob)) continue;
      add(String(r[s.code] || '').trim(), r[s.name], `${s.mkt}重大訊息：法說會/財報`, String(r['發言日期'] || ''));
      hit++;
    }
    console.log(`  ${s.mkt}每日重大訊息：${j.length} 筆，命中法說會/財報 ${hit} 筆`);
  }

  // 季度損益表：官方一次給出全部公司的最新季別，用它判斷「這家公司已經有新一季財報了」
  const fins = [
    { url: 'https://openapi.twse.com.tw/v1/opendata/t187ap06_L_ci', code: '公司代號', name: '公司名稱', y: '年度', s: '季別', mkt: '上市' },
    { url: 'https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap06_O_ci', code: 'SecuritiesCompanyCode', name: 'CompanyName', y: 'Year', s: 'Season', mkt: '上櫃' }
  ];
  const latestFin = {};
  for (const f of fins) {
    const j = await getJson(f.url, UA_TW);
    if (!j || !Array.isArray(j)) { console.warn(`⚠️ ${f.mkt}季度損益表取得失敗`); continue; }
    for (const r of j) {
      const code = String(r[f.code] || '').trim();
      if (!/^\d{4}$/.test(code)) continue;
      latestFin[code] = { year: rocToAd(r[f.y]), season: Number(r[f.s]), name: r[f.name] };
    }
    console.log(`  ${f.mkt}季度損益表：${j.length} 家公司`);
  }
  return { events: [...out.values()], latestFin };
}

// ── 主流程 ──
const days = Number(process.env.LOOKBACK_DAYS || 3);
console.log(`▶ 事件偵測開始（回看 ${days} 天）`);

const state = loadCurrentState();
console.log(`目前站上已有 ${Object.keys(state).length} 家公司的法說會資料`);

console.log('▶ 美股（SEC 每日索引）');
const us = await detectUS(days);
console.log(`  → 有新申報的美股公司：${us.length} 家`);

console.log('▶ 台股（TWSE / TPEx 官方 OpenAPI）');
const { events: twEvents, latestFin } = await detectTW();
console.log(`  → 有法說會/財報事件的台股公司：${twEvents.length} 家`);

// 台股：比對「官方最新季別」vs「我們站上記錄的季度」，落後的也要排進佇列
const twStale = [];
for (const [code, fin] of Object.entries(latestFin)) {
  const have = state[code] || '';
  const wantQ = `${fin.year}`, wantS = fin.season;
  const m = have.match(/(20\d\d)\D*第?\s*([一二三四1-4])\s*季/);
  const cn = { '一': 1, '二': 2, '三': 3, '四': 4 };
  const haveY = m ? Number(m[1]) : 0;
  const haveS = m ? (cn[m[2]] || Number(m[2])) : 0;
  if (!have || haveY < fin.year || (haveY === Number(wantQ) && haveS < wantS)) {
    twStale.push({
      market: 'tw', symbol: code, name: fin.name,
      reason: have ? `官方已有 ${fin.year} 第${wantS}季，站上停在「${have}」` : '站上尚無此公司資料',
      officialQuarter: `${fin.year} 第${wantS}季`
    });
  }
}
console.log(`  → 台股資料落後官方季別的公司：${twStale.length} 家`);

// 優先序（使用者第十點）：有明確法說會事件的最優先，其次是資料落後的，冷門補齊排最後
const queue = [
  ...twEvents.map(e => ({ ...e, priority: 'HIGH' })),
  ...us.map(e => ({ ...e, priority: 'MEDIUM' })),
  ...twStale.filter(e => !twEvents.some(t => t.symbol === e.symbol)).map(e => ({ ...e, priority: state[e.symbol] ? 'MEDIUM' : 'LOW' }))
];

const outDir = path.join(ROOT, 'data', 'events');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'queue.json'), JSON.stringify({
  generatedAt: new Date().toISOString(),
  lookbackDays: days,
  counts: { high: queue.filter(q => q.priority === 'HIGH').length, medium: queue.filter(q => q.priority === 'MEDIUM').length, low: queue.filter(q => q.priority === 'LOW').length, total: queue.length },
  queue
}, null, 1));

// 台股官方季度財務數字一併存下來：這是免費官方來源，可直接餵給 AI 當分析素材，
// 不必再逐家去公司官網抓（官網只在「有法說會事件」時才需要去抓簡報/逐字稿）
fs.writeFileSync(path.join(ROOT, 'data', 'events', 'tw-latest-quarter.json'), JSON.stringify(latestFin, null, 1));

console.log(`✅ 完成：佇列共 ${queue.length} 家（HIGH ${queue.filter(q => q.priority === 'HIGH').length} / MEDIUM ${queue.filter(q => q.priority === 'MEDIUM').length} / LOW ${queue.filter(q => q.priority === 'LOW').length}）`);
console.log(`   對照：若用舊做法要逐家掃描 ${Object.keys(state).length}+ 家，現在只需處理 ${queue.filter(q => q.priority !== 'LOW').length} 家`);
