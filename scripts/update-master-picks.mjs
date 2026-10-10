// 大師選股邏輯推薦 —— 每週依最新財報與本益比重新評分，每位大師台股／美股各挑 3 間
//
// 【為什麼需要】使用者 2026-10-10 要求：
//   「大師邏輯選股推薦改為三間就好，但要隨著時間變化去推薦最好的三間公司，
//     若仍是一樣則不變，若有更好的公司則變化」（之後會停用 Claude，必須無人值守）。
//   原本每位大師的推薦是人工寫死的名單，財報出來、股價變動之後不會跟著變。
//
// 【做法】
//   ① 候選名單＝使用者自己的「第一、二階段公司」（data/stages/stages.json，約 770 家）
//   ② 逐家抓近 4 個年度的營收／毛利／淨利／股東權益／研發費用與目前本益比
//      （Yahoo Finance 彙整之公司年度財報，經網站自己的 /api/proxy）
//   ③ 每位大師一套【寫明的評分公式】（見下方 SCORERS，滿分 100），公式直接對應他公開講過的選股原則
//   ④ 每個市場取前 3 名。原本的 3 間若仍然夠好就不動 ——
//      要有候選公司的分數比它高出 SWAP_MARGIN 分以上才替換，避免每週因為小波動換來換去
//   ⑤ 說明文字全部由數字套版產生，不經過 AI，所以不會有編造的內容
//
// 【誠實的限制】（也會顯示在畫面上）
//   · 只看財務數字，看不到產業變化、管理層品質、一次性事件
//   · Yahoo 的年度資料只有近 4 年，不是完整十年
//   · 這是「依大師公開的選股原則做的量化對照」，不是大師本人的推薦或持股
//
// 【零費用】GitHub Actions（public repo 免費）＋約 800 次網站代理請求／週，不用任何 AI 額度。
//
// 本機執行：node scripts/update-master-picks.mjs          （DRY_RUN=1 只印結果不寫檔；LIMIT=40 只取前 40 家測試）
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SITE = (process.env.SITE_URL || 'https://weicheng-stock.pages.dev').replace(/\/+$/, '');
const DRY_RUN = process.env.DRY_RUN === '1';
const LIMIT = Number(process.env.LIMIT || 0);
const SWAP_MARGIN = 3;        // 新公司要比原本的高出幾分才替換
const PICKS = 3;
const MASTERS = ['buffett', 'lynch', 'munger', 'fisher'];
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── 從主程式讀台股名稱與上櫃名單（與 App 用同一份，不另外維護）──
const html = fs.readFileSync(path.join(ROOT, 'stock_analyzer.html'), 'utf8');
const TW_ALL = (() => { try { const m = html.match(/const TW_ALL=(\{.*?\});/s); return new Function('return ' + m[1])(); } catch (e) { return {}; } })();
const TW_OTC = (() => { try { return new Set(JSON.parse(html.match(/const TW_OTC=new Set\((\[[^\]]*\])\)/)[1])); } catch (e) { return new Set(); } })();
const isTwCode = c => /^\d{4,6}$/.test(c);
const symOf = c => isTwCode(c) ? c + (TW_OTC.has(c) ? '.TWO' : '.TW') : c;

// ── 候選名單 ──
const stages = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'stages', 'stages.json'), 'utf8')).stages;
let universe = [...new Set([...(stages['1'] || []), ...(stages['2'] || [])])];
// 同一家公司的不同股別只留一個，否則前三名會被同一家公司佔掉兩席（實測：GOOG 與 GOOGL 同時入選）
const SAME_COMPANY = { GOOG: 'GOOGL', 'BRK-A': 'BRK-B', FOX: 'FOXA', NWS: 'NWSA' };
universe = universe.filter(c => !(SAME_COMPANY[c] && universe.includes(SAME_COMPANY[c])));
if (LIMIT) universe = [...universe.filter(isTwCode).slice(0, LIMIT), ...universe.filter(c => !isTwCode(c)).slice(0, LIMIT)];

// ── 抓資料 ──
const TYPES = 'annualTotalRevenue,annualGrossProfit,annualNetIncome,annualStockholdersEquity,annualTotalAssets,annualResearchAndDevelopment,trailingPeRatio';
async function getJson(url, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(20000) }); if (r.ok) return await r.json(); if (r.status === 404) return null; }
    catch (e) {}
    await sleep(1500 * i);
  }
  return null;
}
const proxied = u => SITE + '/api/proxy?url=' + encodeURIComponent(u);
async function fetchFin(sym) {
  const now = Math.floor(Date.now() / 1000), p1 = now - 86400 * 365 * 6;
  const j = await getJson(proxied(`https://query1.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${sym}?symbol=${sym}&type=${TYPES}&period1=${p1}&period2=${now}`));
  const res = j && j.timeseries && j.timeseries.result || [];
  const series = t => { const x = res.find(a => a.meta && a.meta.type && a.meta.type[0] === t); const m = {}; let cur = '';
    for (const p of (x && x[t] || [])) if (p && p.asOfDate && p.reportedValue && p.reportedValue.raw != null) { m[p.asOfDate] = p.reportedValue.raw; if (p.currencyCode) cur = p.currencyCode; }
    return { m, cur }; };
  const rev = series('annualTotalRevenue');
  return { rev: rev.m, cur: rev.cur, gp: series('annualGrossProfit').m, ni: series('annualNetIncome').m, eq: series('annualStockholdersEquity').m,
    rd: series('annualResearchAndDevelopment').m, ta: series('annualTotalAssets').m, pe: series('trailingPeRatio').m };
}

// ── 指標 ──
function metrics(f) {
  const dates = Object.keys(f.rev).sort();
  if (dates.length < 3) return null;
  const rows = dates.map(d => { const rev = f.rev[d], gp = f.gp[d], ni = f.ni[d], eq = f.eq[d], rd = f.rd[d];
    return { d, rev, ni, gm: (rev && gp != null) ? gp / rev * 100 : null, nm: (rev && ni != null) ? ni / rev * 100 : null,
      roe: (eq && eq > 0 && ni != null) ? ni / eq * 100 : null, rd: (rev && rd != null) ? rd / rev * 100 : null }; });
  const last = rows[rows.length - 1], first = rows[0];
  if (!(last.rev > 0) || !(first.rev > 0)) return null;
  const lastDate = new Date(last.d);
  if ((Date.now() - lastDate.getTime()) / 86400000 > 800) return null;       // 最新年報超過兩年多 → 資料太舊不評
  const n = rows.length, span = n - 1;
  const cagr = (a, b) => (a > 0 && b > 0) ? (Math.pow(b / a, 1 / span) - 1) * 100 : null;
  const roes = rows.map(r => r.roe).filter(v => v != null);
  const gms = rows.map(r => r.gm).filter(v => v != null);
  let declines = 0; for (let i = 1; i < n; i++) if (rows[i].rev < rows[i - 1].rev) declines++;
  const peK = Object.keys(f.pe).sort(); const pe = peK.length ? f.pe[peK[peK.length - 1]] : null;
  const revCagr = cagr(first.rev, last.rev), niCagr = cagr(first.ni, last.ni);
  const growth = niCagr != null ? niCagr : revCagr;                           // 林區看獲利成長；首尾有一年虧損時退回用營收成長
  return { n, span, fy: last.d.slice(0, 4), fyEnd: last.d, cur: f.cur, rev: last.rev, revPrev: rows[n - 2].rev, ni: last.ni,
    gm: last.gm, nm: last.nm, roe: last.roe, roeAvg: roes.length ? roes.reduce((a, b) => a + b, 0) / roes.length : null, roeMin: roes.length ? Math.min(...roes) : null,
    revCagr, niCagr, growth, growthIsNi: niCagr != null, declines, niAllPos: rows.every(r => r.ni != null && r.ni > 0),
    gmTrend: gms.length >= 2 ? gms[gms.length - 1] - gms[0] : null, rd: last.rd, pe: (pe != null && pe > 0) ? pe : null,
    // 自有資本比率＝股東權益 ÷ 總資產。比率很低代表高槓桿，這時股東權益報酬率會被「灌水」，不代表生意真的好
    eqRatio: (f.ta[last.d] > 0 && f.eq[last.d] != null) ? f.eq[last.d] / f.ta[last.d] * 100 : null,
    peg: (pe != null && pe > 0 && growth != null && growth > 0) ? pe / growth : null };
}

// ── 評分公式（滿分 100）──────────────────────────────────────────
//   lin(v, [[x, 分數], …])：依錨點做線性內插，連續給分。
//   ⚠️ 第一版是「跨過門檻就給固定分數」，實測 770 家裡一堆公司同時拿到滿分 100，
//      排名最後只靠本益比決定，「有更好的公司才替換」完全失去意義。
//      改成連續給分後，股東權益報酬率 31% 就是比 21% 高分，才分得出高下。
//   v 為 null（沒有資料）時給 nullPts；低於第一個錨點取第一個分數，高於最後一個取最後一個。
const lin = (v, pts, nullPts = 0) => {
  if (v == null || !Number.isFinite(v)) return nullPts;
  if (v <= pts[0][0]) return pts[0][1];
  for (let k = 1; k < pts.length; k++) if (v <= pts[k][0]) { const [x0, y0] = pts[k - 1], [x1, y1] = pts[k]; return Math.round((y0 + (y1 - y0) * (v - x0) / (x1 - x0)) * 10) / 10; }
  return pts[pts.length - 1][1];
};
const f1 = v => v == null ? '—' : (Math.round(v * 10) / 10).toFixed(1);
const P = (k, got, max, val) => ({ k, got, max, val });
// ── 扣分項（2026-10-10 檢查第一版結果時發現的兩個公式漏洞）──
//   ① 財務槓桿：蒙格美股第一名算出「西蒙地產」（不動產信託）—— 它的股東權益報酬率高，是因為
//      舉債很多、股東權益很薄，而巴菲特與蒙格最反對的就是靠槓桿撐出來的報酬率。
//      自有資本比率（股東權益÷總資產）低於 40% 開始扣分，10% 以下扣 15 分。
//      ⚠️ 銀行、保險、券商的自有資本比率天生就低，會被這一項排除 —— 這套公式本來就無法評估金融業。
//   ② 目前仍虧損：費雪美股算出還在虧損的公司。費雪看重的是「能把成長變成利潤」，最新年度虧損扣 15 分。
const LEVERAGE = m => P('財務槓桿（扣分項）', -lin(m.eqRatio, [[10, 15], [20, 9], [30, 4], [40, 0]], 0), 0, m.eqRatio != null ? `股東權益占總資產 ${f1(m.eqRatio)}%` : '無資料');
const LOSS = m => P('目前仍虧損（扣分項）', (m.ni != null && m.ni <= 0) ? -15 : 0, 0, (m.ni != null && m.ni <= 0) ? '最新年度虧損' : '最新年度獲利');
const SCORERS = {
  // 巴菲特：有護城河（高且穩定的股東權益報酬率、定價能力）＋獲利可預測＋價格合理
  buffett: m => [
    P('股東權益報酬率持續性', lin(m.roeAvg, [[0, 0], [10, 8], [15, 18], [20, 25], [35, 30]]) - ((m.roeMin != null && m.roeMin < 10) ? 4 : 0), 30, `近 ${m.n} 年平均 ${f1(m.roeAvg)}%、最低 ${f1(m.roeMin)}%`),
    m.gm != null ? P('定價能力（毛利率）', lin(m.gm, [[0, 0], [20, 6], [30, 11], [40, 15], [70, 20]]), 20, `${f1(m.gm)}%`)
                 : P('定價能力（無毛利率，改看淨利率）', lin(m.nm, [[0, 0], [10, 8], [15, 11], [25, 14], [40, 16]]), 20, `淨利率 ${f1(m.nm)}%`),
    P('獲利可預測', !m.niAllPos ? 3 : [20, 15, 9, 4][Math.min(m.declines, 3)], 20, `${m.niAllPos ? '年年獲利' : '曾有虧損'}、營收衰退 ${m.declines} 年`),
    P('獲利留存（淨利率）', lin(m.nm, [[0, 0], [5, 4], [10, 7], [30, 10]]), 10, `${f1(m.nm)}%`),
    P('價格合理（本益比）', lin(m.pe, [[8, 20], [15, 18], [20, 14], [25, 10], [35, 5], [60, 0]], 5), 20, m.pe ? `${f1(m.pe)} 倍` : '無資料'),
    LEVERAGE(m)
  ],
  // 彼得林區：成長夠快、而且價格相對於成長划算（PEG）。成長超過 50% 他認為難以持續，反而扣分
  lynch: m => [
    P('成長速度', lin(m.growth, [[0, 0], [5, 9], [10, 17], [15, 25], [20, 31], [25, 35], [50, 35], [80, 22]]), 35, `${m.growthIsNi ? '獲利' : '營收'}年複合成長 ${f1(m.growth)}%`),
    P('價格相對成長（PEG）', lin(m.peg, [[0.3, 35], [0.5, 34], [1, 29], [1.5, 20], [2, 10], [3, 2]], 6), 35, m.peg != null ? `PEG ${m.peg.toFixed(2)}` : '無法計算'),
    P('獲利體質', (m.nm != null && m.nm > 0) ? lin(m.roe, [[0, 2], [10, 9], [15, 13], [25, 15]], 4) : 0, 15, `股東權益報酬率 ${f1(m.roe)}%`),
    P('成長一致', [15, 9, 4, 2][Math.min(m.declines, 3)], 15, `營收衰退 ${m.declines} 年`),
    LOSS(m)
  ],
  // 查理蒙格：用合理的價格買「高品質」的公司 —— 報酬率高、而且每一年都高
  munger: m => [
    P('股東權益報酬率水準', lin(m.roeAvg, [[0, 0], [10, 8], [15, 17], [20, 23], [25, 27], [40, 30]]), 30, `近 ${m.n} 年平均 ${f1(m.roeAvg)}%`),
    P('每一年都好', lin(m.roeMin, [[0, 0], [5, 6], [10, 13], [15, 17], [25, 20]]), 20, `最差的一年 ${f1(m.roeMin)}%`),
    P('獲利留存（淨利率）', lin(m.nm, [[0, 0], [5, 5], [10, 10], [15, 14], [25, 18], [40, 20]]), 20, `${f1(m.nm)}%`),
    P('護城河沒有變窄（毛利率變化）', lin(m.gmTrend, [[-8, 2], [-3, 8], [0, 13], [4, 15]], 6), 15, m.gmTrend != null ? `${m.gmTrend >= 0 ? '+' : ''}${f1(m.gmTrend)} 個百分點` : '無毛利率'),
    P('不買太貴（本益比）', lin(m.pe, [[12, 15], [25, 13], [35, 9], [50, 4], [80, 0]], 5), 15, m.pe ? `${f1(m.pe)} 倍` : '無資料'),
    LEVERAGE(m)
  ],
  // 菲利浦費雪：長期成長、持續投入研發、利潤率逐年改善；費雪不太在意本益比，所以不計
  fisher: m => [
    P('營收長期成長', lin(m.revCagr, [[0, 0], [5, 9], [10, 18], [15, 24], [20, 28], [35, 30]]), 30, `年複合成長 ${f1(m.revCagr)}%`),
    P('研發投入', lin(m.rd, [[0, 2], [2, 7], [5, 14], [10, 20], [15, 23], [25, 25]], 2), 25, m.rd != null ? `研發占營收 ${f1(m.rd)}%` : '未揭露研發費用'),
    P('利潤率改善', lin(m.gmTrend, [[-8, 0], [-3, 7], [0, 13], [3, 17], [8, 20]], 5), 20, m.gmTrend != null ? `毛利率 ${m.gmTrend >= 0 ? '+' : ''}${f1(m.gmTrend)} 個百分點` : '無毛利率'),
    P('利潤率水準', lin(m.gm, [[0, 0], [20, 3], [30, 7], [40, 10], [50, 12], [75, 15]], 3), 15, m.gm != null ? `毛利率 ${f1(m.gm)}%` : '無毛利率'),
    P('成長沒有中斷', [10, 6, 3, 1][Math.min(m.declines, 3)], 10, `營收衰退 ${m.declines} 年`),
    LOSS(m)
  ]
};
const total = parts => Math.max(0, Math.round(parts.reduce((a, p) => a + (p.max > 0 ? Math.max(0, p.got) : p.got), 0) * 10) / 10);

// ── 文字（全部由數字套版，不經過 AI）──
const CUR = { TWD: ['新台幣 ', '元'], USD: ['', '美元'], EUR: ['', '歐元'], JPY: ['', '日圓'], DKK: ['', '丹麥克朗'], CNY: ['人民幣 ', '元'], HKD: ['', '港元'], KRW: ['', '韓元'], GBP: ['', '英鎊'], CHF: ['', '瑞士法郎'] };
function money(v, cur) {
  const c = CUR[cur] || ['', cur ? ' ' + cur : '']; const yi = v / 1e8;
  const fmt = (x, d) => (Math.round(x * 10 ** d) / 10 ** d).toLocaleString('en-US', { maximumFractionDigits: d });
  const body = Math.abs(yi) >= 10000 ? Math.floor(yi / 10000).toLocaleString('en-US') + ' 兆 ' + fmt(yi % 10000, 0) + ' 億' : Math.abs(yi) >= 1 ? fmt(yi, Math.abs(yi) >= 100 ? 0 : 1) + ' 億' : fmt(yi * 10000, 0) + ' 萬';
  return c[0] + body + c[1];
}
function facts(m, key) {
  const yoy = m.revPrev > 0 ? (m.rev - m.revPrev) / m.revPrev * 100 : null;
  const a = [`${m.fy} 年度營收 ${money(m.rev, m.cur)}${yoy != null ? `（年${yoy >= 0 ? '增' : '減'} ${f1(Math.abs(yoy))}%）` : ''}`,
    `${m.gm != null ? `毛利率 ${f1(m.gm)}%、` : ''}淨利率 ${f1(m.nm)}%、股東權益報酬率 ${f1(m.roe)}%（近 ${m.n} 年平均 ${f1(m.roeAvg)}%）`,
    `本益比 ${m.pe ? f1(m.pe) + ' 倍' : '無資料'}；近 ${m.span} 年營收年複合成長 ${f1(m.revCagr)}%${m.niCagr != null ? `、獲利年複合成長 ${f1(m.niCagr)}%` : ''}`];
  if (key === 'fisher' && m.rd != null) a.push(`研發費用占營收 ${f1(m.rd)}%`);
  return a;
}
const BUY = {
  buffett: m => `巴菲特要的是「看得懂、長期賺得到錢、價格合理」。這家近 ${m.n} 年平均股東權益報酬率 ${f1(m.roeAvg)}%（最差的一年 ${f1(m.roeMin)}%），${m.niAllPos ? '每一年都獲利' : '期間曾出現虧損'}，營收 ${m.declines === 0 ? '沒有任何一年衰退' : '有 ' + m.declines + ' 年衰退'}；目前本益比 ${m.pe ? f1(m.pe) + ' 倍' : '無資料'}。`,
  lynch: m => m.peg != null
    ? `林區用 PEG 判斷「成長相對於價格划不划算」：本益比 ${f1(m.pe)} 倍 ÷ ${m.growthIsNi ? '獲利' : '營收'}年複合成長率 ${f1(m.growth)}% ＝ ${m.peg.toFixed(2)}。他的經驗是低於 1 划算、高於 2 偏貴。`
    : `近 ${m.span} 年${m.growthIsNi ? '獲利' : '營收'}年複合成長 ${f1(m.growth)}%，但本益比或成長率資料不足，無法計算 PEG。`,
  munger: m => `蒙格寧可用合理價買好公司，也不要用便宜價買普通公司。「好」的定義是報酬率高、而且年年都高：近 ${m.n} 年平均股東權益報酬率 ${f1(m.roeAvg)}%、最差的一年 ${f1(m.roeMin)}%，淨利率 ${f1(m.nm)}%${m.gmTrend != null ? `，毛利率較 ${m.span} 年前${m.gmTrend >= 0 ? '提高' : '下滑'} ${f1(Math.abs(m.gmTrend))} 個百分點` : ''}。`,
  fisher: m => `費雪找的是能長期成長、而且把利潤再投入研發的公司：近 ${m.span} 年營收年複合成長 ${f1(m.revCagr)}%${m.rd != null ? `，研發費用占營收 ${f1(m.rd)}%` : '（未揭露研發費用）'}${m.gmTrend != null ? `，毛利率較 ${m.span} 年前${m.gmTrend >= 0 ? '提高' : '下滑'} ${f1(Math.abs(m.gmTrend))} 個百分點` : ''}。費雪不太在意本益比，所以這裡不計入評分。`
};
function risk(m, key) {
  const r = [];
  if (m.pe && m.pe > 35) r.push(`本益比 ${f1(m.pe)} 倍偏高，成長一旦放緩，股價修正的幅度會很大`);
  if (m.pe == null) r.push('沒有本益比資料（可能是虧損或資料缺漏），無法判斷價格貴不貴');
  if (m.declines > 0) r.push(`近 ${m.n} 年有 ${m.declines} 年營收衰退，成長並不平順`);
  if (m.gmTrend != null && m.gmTrend < -3) r.push(`毛利率較 ${m.span} 年前下滑 ${f1(Math.abs(m.gmTrend))} 個百分點，定價能力可能在變弱`);
  if (m.growth != null && m.growth > 50) r.push(`成長率 ${f1(m.growth)}% 極高，林區提醒這種速度通常無法持續太久`);
  if (m.eqRatio != null && m.eqRatio < 30) r.push(`股東權益只占總資產 ${f1(m.eqRatio)}%，負債比重高，景氣反轉時風險較大`);
  if (m.roe != null && m.roe > 60) r.push(`股東權益報酬率 ${f1(m.roe)}% 異常高，多半是大量買回庫藏股使股東權益變小造成，不完全代表本業更賺錢`);
  if (key === 'fisher' && m.pe && m.pe > 35) r.push('費雪式的成長股通常不便宜，買進後要能承受大幅波動');
  r.push(`評分只看近 ${m.n} 年的財務數字，看不到產業變化、管理層品質與一次性事件`);
  return r.map((x, i) => '①②③④⑤⑥'[i] + ' ' + x).join('；') + '。';
}
const TAG = {
  buffett: m => `平均股東權益報酬率 ${f1(m.roeAvg)}%`,
  lynch: m => m.peg != null ? `PEG ${m.peg.toFixed(2)}` : `成長 ${f1(m.growth)}%`,
  munger: m => `報酬率年年不低於 ${f1(m.roeMin)}%`,
  fisher: m => `營收年複合成長 ${f1(m.revCagr)}%`
};

// ── 主流程 ──
console.log(`▶ 候選公司 ${universe.length} 家（台股 ${universe.filter(isTwCode).length}、美股 ${universe.filter(c => !isTwCode(c)).length}）`);
const data = new Map();   // code → metrics
let fail = 0, thin = 0;
for (let i = 0; i < universe.length; i += 5) {
  await Promise.all(universe.slice(i, i + 5).map(async code => {
    try { const f = await fetchFin(symOf(code)); const m = f && metrics(f); if (m) data.set(code, m); else thin++; } catch (e) { fail++; }
  }));
  if ((i / 5) % 20 === 19) console.log(`  …已處理 ${Math.min(i + 5, universe.length)}/${universe.length}`);
  await sleep(250);
}
console.log(`  可評分 ${data.size} 家；資料不足 ${thin} 家；抓取失敗 ${fail} 家`);
if (data.size < Math.min(60, universe.length * 0.3)) { console.error('❌ 可評分的公司太少，可能是資料來源異常；為避免用殘缺資料改掉推薦，這次不更新'); process.exit(1); }

async function usName(code) {   // 美股名稱：只對入選的幾家多問一次
  const j = await getJson(proxied(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(code)}?range=1d&interval=1d`), 2);
  const mt = j && j.chart && j.chart.result && j.chart.result[0] && j.chart.result[0].meta;
  return (mt && (mt.longName || mt.shortName)) || code;
}
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
let anyChange = false;
const summary = [];
for (const key of MASTERS) {
  const file = path.join(ROOT, 'data', 'masters', key + '.json');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  // 人工寫的「這門生意為什麼符合」保留成資料庫：入選的公司剛好有人工說明就沿用，沒有才用數字套版
  doc.library = doc.library || {};
  for (const mk of ['tw', 'us']) for (const p of (doc[mk] && doc[mk].picks) || []) if (p.fit && !p.auto && !doc.library[p.code]) doc.library[p.code] = { fit: p.fit, name: p.name };

  for (const mk of ['tw', 'us']) {
    const pool = [...data.entries()].filter(([c]) => (mk === 'tw') === isTwCode(c))
      .map(([code, m]) => { const parts = SCORERS[key](m); return { code, m, parts, score: total(parts) }; })
      .sort((a, b) => b.score - a.score || (a.m.pe || 9e9) - (b.m.pe || 9e9));
    if (pool.length < PICKS) { console.log(`  ⚠️ ${key}/${mk} 候選不足，維持原樣`); continue; }
    const prev = ((doc[mk] && doc[mk].picks) || []).filter(p => p.auto).map(p => p.code);
    let chosen = pool.slice(0, PICKS);
    // 「若仍是一樣則不變，若有更好的公司則變化」：原本的公司只要沒有被別人贏過 SWAP_MARGIN 分以上，就留著
    for (const code of prev) {
      if (chosen.some(x => x.code === code)) continue;
      const inc = pool.find(x => x.code === code); if (!inc) continue;
      const rivals = chosen.filter(x => !prev.includes(x.code)).sort((a, b) => a.score - b.score);
      if (rivals.length && rivals[0].score - inc.score < SWAP_MARGIN) chosen[chosen.indexOf(rivals[0])] = inc;
    }
    // 名單沒變就維持原本的順序，畫面才不會每週跳動
    const sameSet = prev.length === PICKS && chosen.every(x => prev.includes(x.code));
    chosen.sort(sameSet ? (a, b) => prev.indexOf(a.code) - prev.indexOf(b.code) : (a, b) => b.score - a.score);

    const oldPicks = (doc[mk] && doc[mk].picks) || [];
    const picks = [];
    for (const x of chosen) {
      const old = oldPicks.find(p => p.code === x.code && p.auto);
      const lib = doc.library[x.code];
      const name = mk === 'tw' ? (TW_ALL[x.code] || (lib && lib.name) || x.code) : ((old && old.name) || (lib && lib.name) || await usName(x.code));
      picks.push({ auto: true, code: x.code, symbol: symOf(x.code), name, tag: TAG[key](x.m), score: x.score,
        parts: x.parts.filter(p => p.max > 0 || p.got < 0).map(p => ({ k: p.k, got: p.max > 0 ? Math.max(0, p.got) : p.got, max: p.max, val: p.val })),
        // 符合邏輯：有人工寫的「這門生意為什麼符合」就沿用；沒有就列出得分最高的兩個項目（純數字，不臆測）
        fit: lib ? lib.fit : (() => { const top = x.parts.filter(q => q.max > 0).sort((a, b) => b.got / b.max - a.got / a.max).slice(0, 2); return `依這位大師的原則逐項評分，總分 ${x.score} 分（滿分 100）。得分最高的兩項是「${top[0].k}」（${top[0].val}）與「${top[1].k}」（${top[1].val}）。`; })(),
        facts: facts(x.m, key), buy: BUY[key](x.m), risk: risk(x.m, key),
        since: (old && old.since) || today });
    }
    const added = picks.filter(p => !prev.includes(p.code)).map(p => p.name), removed = prev.filter(c => !picks.some(p => p.code === c)).map(c => (oldPicks.find(p => p.code === c) || {}).name || c);
    const first = !prev.length;
    const changed = first || added.length > 0;
    if (changed) anyChange = true;
    const fys = [...new Set(chosen.map(x => x.m.fy))].sort();
    doc[mk] = {
      asOf: `${fys.join('／')} 年度財報與 ${today} 的本益比`,
      sourceName: 'Yahoo Finance 彙整之公司年度財報（非交易所原始申報檔）',
      auto: true, updatedAt: today, poolSize: pool.length,
      note: `這 ${PICKS} 間是從你的第一、二階段公司（本次可評分 ${pool.length} 家）依上方評分公式算出來的前 ${PICKS} 名。每週自動重算一次；名單仍然最好就不變，有公司分數高出 ${SWAP_MARGIN} 分以上才替換。`,
      lastChange: changed ? (first ? `${today} 改為自動評分` : `${today}：新進 ${added.join('、')}；移出 ${removed.join('、')}`) : ((doc[mk] && doc[mk].lastChange) || ''),
      runnerUp: pool.filter(x => !chosen.includes(x)).slice(0, 3).map(x => ({ code: x.code, name: mk === 'tw' ? (TW_ALL[x.code] || x.code) : x.code, score: x.score })),
      picks
    };
    summary.push(`${key}/${mk}: ` + picks.map(p => `${p.name}(${p.score})`).join('、') + (changed && !first ? `  ← 變動：+${added.join(',')} −${removed.join(',')}` : sameSet ? '  （不變）' : ''));
  }
  if (!DRY_RUN) fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
}
console.log('\n' + summary.join('\n'));
console.log(DRY_RUN ? '\n（DRY_RUN：未寫入檔案）' : `\n✅ 已更新 data/masters/*.json${anyChange ? '（推薦名單有變動）' : '（推薦名單不變，只更新數字）'}`);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, '# 大師選股每週重算\n\n```\n' + summary.join('\n') + '\n```\n');
