// 產生 data/stages/stages.json —— 每家公司屬於使用者「五階段」的哪一階。
//
// 【為什麼需要】
//   每日排程一天最多分析 40 家（免費額度考量）。使用者要求的順序是：
//     使用者主動點過的公司 → 第一階段 → 第二階段 → 第三階段 → 第四階段 → 第五階段 → 其他
//   （2026-09-19 使用者原話：「如果每天的使用者去點的不到 40 間，則依照我的五階段公司去更新」）
//   這支腳本只負責「分階段」；排序本身在 analyze-earnings.mjs。
//
// 【五階段的定義】（使用者 2026-08-14 訂下的路線圖，見交接記錄）
//   1. 美股台灣人最常交易 100 家 ＋ 台股台灣人最常交易 200 家 ＋ 投資主題（THEME_STOCKS）公司
//   2. 美股 S&P 500（以及道瓊、那斯達克、費半中已在 S&P 500 內者）
//   3. 台股上市公司（TWSE）
//   4. 美股道瓊／那斯達克／費半中「不在 S&P 500」的公司
//   5. 台股上櫃公司（TPEx）
//   同一家公司只歸在「最前面」那一階（例如台積電同時是上市公司，但歸第一階段）。
//
// 【資料來源】
//   第一階段：data/stages/stage1-whitelist.json（由使用者提供的 Excel 轉出）＋ stock_analyzer.html 的 THEME_STOCKS
//   第二階段：人工建置過的美股（data/ir/*.json）＋ 交接清單/第二階段缺口清單，扣掉第一、四階段
//   第三、五階段：證交所／櫃買中心官方公司名單 API —— 新上市櫃的公司會自動納入
//   第四階段：交接清單/第四階段缺口清單
//   官方 API 連不上時，沿用上一次產生的名單，不會讓分階段整個消失。
//
// 用法：node scripts/build-stages.mjs
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'data', 'stages', 'stages.json');
const UA = { 'User-Agent': 'Mozilla/5.0 (stock-analyzer build-stages)' };

// 美股代碼統一成 SEC 的寫法（BRK.B → BRK-B），比對時才不會因為點和槓對不上
const normUs = s => String(s).trim().toUpperCase().replace(/\./g, '-');
const isTw = s => /^\d{4,6}[A-Z]?$/.test(String(s));

function readLines(file) {
  try {
    return fs.readFileSync(path.join(ROOT, file), 'utf8').split(/\r?\n/)
      .map(l => l.trim().split(/\s+/)[0]).filter(Boolean);
  } catch (e) { return []; }
}

function loadThemeStocks() {
  try {
    const html = fs.readFileSync(path.join(ROOT, 'stock_analyzer.html'), 'utf8');
    const i = html.indexOf('const THEME_STOCKS');
    const st = html.indexOf('{', i);
    let d = 0, j = st;
    for (; j < html.length; j++) {
      if (html[j] === '{') d++;
      else if (html[j] === '}') { d--; if (d === 0) { j++; break; } }
    }
    const obj = new Function('return ' + html.slice(st, j))();
    const tw = [], us = [];
    for (const v of Object.values(obj)) { (v.tw || []).forEach(x => tw.push(String(x))); (v.us || []).forEach(x => us.push(normUs(x))); }
    return { tw, us };
  } catch (e) { console.log('⚠️ 讀不到 THEME_STOCKS：' + e.message); return { tw: [], us: [] }; }
}

async function fetchCodes(url, field) {
  try {
    const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    const codes = j.map(x => String(x[field] || '').trim()).filter(isTw);
    if (codes.length < 100) throw new Error('只拿到 ' + codes.length + ' 家，疑似 API 異常');
    return codes;
  } catch (e) { console.log('⚠️ ' + url + ' 失敗：' + e.message + '（沿用上一次的名單）'); return null; }
}

const prev = (() => { try { return JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (e) { return null; } })();

// ── 第一階段 ──
const wl = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'stages', 'stage1-whitelist.json'), 'utf8'));
const theme = loadThemeStocks();
const s1 = [...new Set([...wl.tw, ...theme.tw, ...wl.us.map(normUs), ...theme.us])];

// ── 第四階段 ──
const s4raw = readLines('交接清單/第四階段_美股道瓊那斯達克費半缺口清單.txt').map(normUs);

// ── 第二階段：人工建置過的美股 ＋ 第二階段缺口清單 ──
const irUs = fs.readdirSync(path.join(ROOT, 'data', 'ir'))
  .filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, '')).filter(s => !isTw(s)).map(normUs);
const s2raw = [...readLines('交接清單/第二階段_SP500缺口清單.txt').map(normUs), ...irUs];

// ── 第三、五階段：官方上市／上櫃名單 ──
const listed = await fetchCodes('https://openapi.twse.com.tw/v1/opendata/t187ap03_L', '公司代號');
const otc = await fetchCodes('https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O', 'SecuritiesCompanyCode');
const s3raw = listed || (prev && prev.stages['3']) || readLines('交接清單/第三階段_台股上市缺口清單.txt');
const s5raw = otc || (prev && prev.stages['5']) || readLines('交接清單/第五階段_台股上櫃缺口清單.txt');

// 同一家公司只歸在最前面那一階
const seen = new Set();
const take = arr => arr.filter(s => s && !seen.has(s) && seen.add(s));
const stages = {
  '1': take(s1),
  '4': [],   // 先佔位，第四階段要在第二階段之前扣掉（不然會被第二階段吃掉）
};
const s4 = take(s4raw);
stages['2'] = take(s2raw);
stages['3'] = take(s3raw);
stages['4'] = s4;
stages['5'] = take(s5raw);

const out = {
  _說明: '每家公司屬於使用者五階段的哪一階（由 scripts/build-stages.mjs 產生，每日排程開始時更新）。排程依「使用者點過的 → 1 → 2 → 3 → 4 → 5 → 其他」分配每日 40 家的名額。',
  generatedAt: new Date().toISOString(),
  sources: { 上市名單: listed ? '證交所 OpenAPI（本次即時）' : '沿用舊名單', 上櫃名單: otc ? '櫃買中心 OpenAPI（本次即時）' : '沿用舊名單' },
  counts: Object.fromEntries(Object.entries(stages).sort().map(([k, v]) => [k, v.length])),
  stages: Object.fromEntries(Object.entries(stages).sort())
};
fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
console.log('✅ 已產生 ' + path.relative(ROOT, OUT) + '：' + Object.entries(out.counts).map(([k, v]) => '第' + k + '階段 ' + v + ' 家').join('、'));
