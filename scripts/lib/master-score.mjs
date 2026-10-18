// 大師選股評分公式 —— 每週排程（scripts/update-master-picks.mjs）與 App 前端
// 「大師選股邏輯推薦 → 用大師觀點看任一檔股票」共用同一份，確保兩邊算出的分數一模一樣。
// ⚠️ 這個檔案會被瀏覽器直接載入（Cloudflare Pages 以專案根目錄為網站），
//    所以只能用純 JavaScript：不可 import Node 模組、不可用 fs／process。
//    改公式就是同時改了排程與 App，兩邊不會再出現不同版本。

export const TYPES = 'annualTotalRevenue,annualGrossProfit,annualNetIncome,annualStockholdersEquity,annualTotalAssets,annualResearchAndDevelopment,trailingPeRatio';
// Yahoo fundamentals-timeseries 回應 → 評分需要的各年度數字
export function parseFin(j) {
  const res = j && j.timeseries && j.timeseries.result || [];
  const series = t => { const x = res.find(a => a.meta && a.meta.type && a.meta.type[0] === t); const m = {}; let cur = '';
    for (const p of (x && x[t] || [])) if (p && p.asOfDate && p.reportedValue && p.reportedValue.raw != null) { m[p.asOfDate] = p.reportedValue.raw; if (p.currencyCode) cur = p.currencyCode; }
    return { m, cur }; };
  const rev = series('annualTotalRevenue');
  return { rev: rev.m, cur: rev.cur, gp: series('annualGrossProfit').m, ni: series('annualNetIncome').m, eq: series('annualStockholdersEquity').m,
    rd: series('annualResearchAndDevelopment').m, ta: series('annualTotalAssets').m, pe: series('trailingPeRatio').m };
}

// ════════════════════════════════════════════════════════════════
// 【近 10 年財報】2026-10-18 使用者認為台積電分數偏低，請我檢查並同意改用 10 年財報。
//   原因：Yahoo 免費資料只有近 4 個年度，一次景氣循環低谷（台積電 2023 年營收年減）就佔整段的三分之一；
//   巴菲特、費雪看的本來就是長期紀錄，App 其他財務指標也都看 10 年。
//   台股用 FinMind（彙整公開資訊觀測站財報，App 財務指標本來就在用）、美股用 SEC 官方申報；
//   Yahoo 仍負責本益比、研發費用與 FinMind／SEC 還沒有的最新年度。抓取由呼叫端各自處理（排程直連、App 走代理），
//   這裡只做「解析＋合併」，排程與 App 用同一份，分數才會一致。
// ════════════════════════════════════════════════════════════════
const EMPTY = () => ({ rev: {}, gp: {}, ni: {}, eq: {}, ta: {} });
// FinMind 綜合損益表（逐季、單季數字）＋資產負債表 → 年度。只收四季都齊的年份。
export function parseFinMind(fsJson, bsJson) {
  const out = EMPTY(), acc = {};
  for (const r of (fsJson && fsJson.data) || []) {
    const k = { Revenue: 'rev', GrossProfit: 'gp', IncomeAfterTaxes: 'ni' }[r.type]; if (!k) continue;
    const y = String(r.date).slice(0, 4), v = Number(r.value); if (!Number.isFinite(v)) continue;
    const a = acc[y] = acc[y] || { rev: 0, gp: 0, ni: 0, q: { rev: new Set(), gp: new Set(), ni: new Set() } };
    a[k] += v; a.q[k].add(r.date);
  }
  for (const [y, a] of Object.entries(acc)) {
    if (a.q.rev.size !== 4) continue;
    const d = y + '-12-31';
    out.rev[d] = a.rev; if (a.q.gp.size === 4) out.gp[d] = a.gp; if (a.q.ni.size === 4) out.ni[d] = a.ni;
  }
  for (const r of (bsJson && bsJson.data) || []) {
    if (!/-12-31$/.test(r.date)) continue;
    const v = Number(r.value); if (!Number.isFinite(v)) continue;
    if (r.type === 'EquityAttributableToOwnersOfParent') out.eq[r.date] = v;
    else if (r.type === 'TotalAssets') out.ta[r.date] = v;
  }
  return out;
}
// SEC companyfacts → 年度（10-K／20-F／40-F 的全年數字；同一期間以最後申報者為準）
const SEC_TAGS = {
  rev: ['us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax', 'us-gaap:Revenues', 'us-gaap:SalesRevenueNet', 'us-gaap:RevenueFromContractWithCustomerIncludingAssessedTax', 'us-gaap:RevenuesNetOfInterestExpense', 'ifrs-full:Revenue', 'ifrs-full:RevenueFromContractsWithCustomers'],
  gp: ['us-gaap:GrossProfit', 'ifrs-full:GrossProfit'],
  cost: ['us-gaap:CostOfRevenue', 'us-gaap:CostOfGoodsAndServicesSold', 'us-gaap:CostOfGoodsSold', 'ifrs-full:CostOfSales'],
  ni: ['us-gaap:NetIncomeLoss', 'us-gaap:ProfitLoss', 'ifrs-full:ProfitLossAttributableToOwnersOfParent', 'ifrs-full:ProfitLoss'],
  eq: ['us-gaap:StockholdersEquity', 'us-gaap:StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest', 'ifrs-full:EquityAttributableToOwnersOfParent', 'ifrs-full:Equity'],
  ta: ['us-gaap:Assets', 'ifrs-full:Assets']
};
export function parseSecFacts(j) {
  const out = EMPTY(), facts = (j && j.facts) || {};
  const pick = (tags, instant) => {
    const m = {};
    for (const t of tags) {
      const [ns, name] = t.split(':'); const u = facts[ns] && facts[ns][name] && facts[ns][name].units; if (!u) continue;
      const arr = Object.values(u)[0] || [];   // 只有一種貨幣單位；多種時取第一種（同一家公司的財報幣別固定）
      for (const x of arr) {
        if (!x.form || !/^(10-K|20-F|40-F)/.test(x.form) || !x.end) continue;
        if (!instant) { if (!x.start) continue; const days = (new Date(x.end) - new Date(x.start)) / 864e5; if (days < 340 || days > 380) continue; }
        if (m[x.end] && m[x.end].filed >= x.filed) continue;
        m[x.end] = { v: x.val, filed: x.filed || '' };
      }
      if (Object.keys(m).length >= 3) break;   // 依優先順序，第一個有足夠年份的標籤就用
    }
    return Object.fromEntries(Object.entries(m).map(([d, x]) => [d, x.v]));
  };
  out.rev = pick(SEC_TAGS.rev); out.gp = pick(SEC_TAGS.gp); out.ni = pick(SEC_TAGS.ni);
  out.eq = pick(SEC_TAGS.eq, true); out.ta = pick(SEC_TAGS.ta, true);
  if (!Object.keys(out.gp).length) { const c = pick(SEC_TAGS.cost); for (const d in out.rev) if (c[d] != null) out.gp[d] = out.rev[d] - c[d]; }
  return out;
}
// 合併：官方 10 年歷史為主，Yahoo 補「官方還沒有的最新年度」；本益比、研發費用沿用 Yahoo。
//   重疊年份的營收差超過 10%（幣別或口徑不同）就不混用 Yahoo 的年度數字，只用官方歷史。
export function mergeHistory(y, h, maxYears = 10) {
  if (!h || Object.keys(h.rev || {}).length < 3) return { ...y, years: Object.keys(y.rev || {}).length, src: 'yahoo' };
  const yr = d => String(d).slice(0, 4);
  const hByYear = new Map(Object.keys(h.rev).map(d => [yr(d), d]));
  let same = true, overlap = 0;
  for (const d of Object.keys(y.rev || {})) { const hd = hByYear.get(yr(d)); if (hd && h.rev[hd] > 0) { overlap++; const r = y.rev[d] / h.rev[hd]; if (r < 0.9 || r > 1.1) same = false; } }
  const out = { rev: { ...h.rev }, gp: { ...h.gp }, ni: { ...h.ni }, eq: { ...h.eq }, ta: { ...h.ta } };
  if (same) for (const d of Object.keys(y.rev || {})) {
    if (hByYear.has(yr(d))) continue;
    for (const k of Object.keys(out)) if (y[k] && y[k][d] != null) out[k][d] = y[k][d];
  }
  const dates = Object.keys(out.rev).sort().slice(-maxYears);
  const keep = o => Object.fromEntries(Object.entries(o).filter(([d]) => dates.includes(d)));
  // 研發費用（費雪用）以年份對齊：官方期間結束日與 Yahoo 的日期可能差幾天（美股非 12 月制）
  const rd = {}; for (const d of dates) { const yd = Object.keys(y.rd || {}).find(x => yr(x) === yr(d)); if (yd) rd[d] = y.rd[yd]; }
  return { rev: keep(out.rev), gp: keep(out.gp), ni: keep(out.ni), eq: keep(out.eq), ta: keep(out.ta), rd,
    pe: y.pe || {}, cur: y.cur, years: dates.length, src: same && overlap ? 'official+yahoo' : 'official' };
}

// ── 指標 ──
export function metrics(f) {
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

// ── 評分公式（滿分 100）──
//   ⚠️ 2026-10-18：「營收衰退幾年」改以「衰退年數 ÷ 期間年數」連續給分。
//      原本是 4 年資料寫死「衰退 1 年扣幾分」；改成 10 年後同樣一次景氣低谷的比重應該變小。
//      4 年資料時（期間 3 年）各錨點的分數與改版前完全相同。────────────────────────────────────────
//   lin(v, [[x, 分數], …])：依錨點做線性內插，連續給分。
//   ⚠️ 第一版是「跨過門檻就給固定分數」，實測 770 家裡一堆公司同時拿到滿分 100，
//      排名最後只靠本益比決定，「有更好的公司才替換」完全失去意義。
//      改成連續給分後，股東權益報酬率 31% 就是比 21% 高分，才分得出高下。
//   v 為 null（沒有資料）時給 nullPts；低於第一個錨點取第一個分數，高於最後一個取最後一個。
export const lin = (v, pts, nullPts = 0) => {
  if (v == null || !Number.isFinite(v)) return nullPts;
  if (v <= pts[0][0]) return pts[0][1];
  for (let k = 1; k < pts.length; k++) if (v <= pts[k][0]) { const [x0, y0] = pts[k - 1], [x1, y1] = pts[k]; return Math.round((y0 + (y1 - y0) * (v - x0) / (x1 - x0)) * 10) / 10; }
  return pts[pts.length - 1][1];
};
export const f1 = v => v == null ? '—' : (Math.round(v * 10) / 10).toFixed(1);
export const P = (k, got, max, val) => ({ k, got, max, val });
// ── 扣分項（2026-10-10 檢查第一版結果時發現的兩個公式漏洞）──
//   ① 財務槓桿：蒙格美股第一名算出「西蒙地產」（不動產信託）—— 它的股東權益報酬率高，是因為
//      舉債很多、股東權益很薄，而巴菲特與蒙格最反對的就是靠槓桿撐出來的報酬率。
//      自有資本比率（股東權益÷總資產）低於 40% 開始扣分，10% 以下扣 15 分。
//      ⚠️ 銀行、保險、券商的自有資本比率天生就低，會被這一項排除 —— 這套公式本來就無法評估金融業。
//   ② 目前仍虧損：費雪美股算出還在虧損的公司。費雪看重的是「能把成長變成利潤」，最新年度虧損扣 15 分。
const LEVERAGE = m => P('財務槓桿（扣分項）', -lin(m.eqRatio, [[10, 15], [20, 9], [30, 4], [40, 0]], 0), 0, m.eqRatio != null ? `股東權益占總資產 ${f1(m.eqRatio)}%` : '無資料');
const LOSS = m => P('目前仍虧損（扣分項）', (m.ni != null && m.ni <= 0) ? -15 : 0, 0, (m.ni != null && m.ni <= 0) ? '最新年度虧損' : '最新年度獲利');
export const SCORERS = {
  // 巴菲特：有護城河（高且穩定的股東權益報酬率、定價能力）＋獲利可預測＋價格合理
  buffett: m => [
    P('股東權益報酬率持續性', lin(m.roeAvg, [[0, 0], [10, 8], [15, 18], [20, 25], [35, 30]]) - ((m.roeMin != null && m.roeMin < 10) ? 4 : 0), 30, `近 ${m.n} 年平均 ${f1(m.roeAvg)}%、最低 ${f1(m.roeMin)}%`),
    m.gm != null ? P('定價能力（毛利率）', lin(m.gm, [[0, 0], [20, 6], [30, 11], [40, 15], [70, 20]]), 20, `${f1(m.gm)}%`)
                 : P('定價能力（無毛利率，改看淨利率）', lin(m.nm, [[0, 0], [10, 8], [15, 11], [25, 14], [40, 16]]), 20, `淨利率 ${f1(m.nm)}%`),
    P('獲利可預測', !m.niAllPos ? 3 : lin(m.declines / m.span, [[0, 20], [1 / 3, 15], [2 / 3, 9], [1, 4]]), 20, `近 ${m.n} 年${m.niAllPos ? '年年獲利' : '曾有虧損'}、營收衰退 ${m.declines} 年`),
    P('獲利留存（淨利率）', lin(m.nm, [[0, 0], [5, 4], [10, 7], [30, 10]]), 10, `${f1(m.nm)}%`),
    P('價格合理（本益比）', lin(m.pe, [[8, 20], [15, 18], [20, 14], [25, 10], [35, 5], [60, 0]], 5), 20, m.pe ? `${f1(m.pe)} 倍` : '無資料'),
    LEVERAGE(m)
  ],
  // 彼得林區：成長夠快、而且價格相對於成長划算（PEG）。成長超過 50% 他認為難以持續，反而扣分
  lynch: m => [
    P('成長速度', lin(m.growth, [[0, 0], [5, 9], [10, 17], [15, 25], [20, 31], [25, 35], [50, 35], [80, 22]]), 35, `${m.growthIsNi ? '獲利' : '營收'}年複合成長 ${f1(m.growth)}%`),
    P('價格相對成長（PEG）', lin(m.peg, [[0.3, 35], [0.5, 34], [1, 29], [1.5, 20], [2, 10], [3, 2]], 6), 35, m.peg != null ? `PEG ${m.peg.toFixed(2)}` : '無法計算'),
    P('獲利體質', (m.nm != null && m.nm > 0) ? lin(m.roe, [[0, 2], [10, 9], [15, 13], [25, 15]], 4) : 0, 15, `股東權益報酬率 ${f1(m.roe)}%`),
    P('成長一致', lin(m.declines / m.span, [[0, 15], [1 / 3, 9], [2 / 3, 4], [1, 2]]), 15, `近 ${m.n} 年營收衰退 ${m.declines} 年`),
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
    P('成長沒有中斷', lin(m.declines / m.span, [[0, 10], [1 / 3, 6], [2 / 3, 3], [1, 1]]), 10, `近 ${m.n} 年營收衰退 ${m.declines} 年`),
    LOSS(m)
  ]
};
export const total = parts => Math.max(0, Math.round(parts.reduce((a, p) => a + (p.max > 0 ? Math.max(0, p.got) : p.got), 0) * 10) / 10);

// ── 文字（全部由數字套版，不經過 AI）──
const CUR = { TWD: ['新台幣 ', '元'], USD: ['', '美元'], EUR: ['', '歐元'], JPY: ['', '日圓'], DKK: ['', '丹麥克朗'], CNY: ['人民幣 ', '元'], HKD: ['', '港元'], KRW: ['', '韓元'], GBP: ['', '英鎊'], CHF: ['', '瑞士法郎'] };
export function money(v, cur) {
  const c = CUR[cur] || ['', cur ? ' ' + cur : '']; const yi = v / 1e8;
  const fmt = (x, d) => (Math.round(x * 10 ** d) / 10 ** d).toLocaleString('en-US', { maximumFractionDigits: d });
  const body = Math.abs(yi) >= 10000 ? Math.floor(yi / 10000).toLocaleString('en-US') + ' 兆 ' + fmt(yi % 10000, 0) + ' 億' : Math.abs(yi) >= 1 ? fmt(yi, Math.abs(yi) >= 100 ? 0 : 1) + ' 億' : fmt(yi * 10000, 0) + ' 萬';
  return c[0] + body + c[1];
}
export function facts(m, key) {
  const yoy = m.revPrev > 0 ? (m.rev - m.revPrev) / m.revPrev * 100 : null;
  const a = [`${m.fy} 年度營收 ${money(m.rev, m.cur)}${yoy != null ? `（年${yoy >= 0 ? '增' : '減'} ${f1(Math.abs(yoy))}%）` : ''}`,
    `${m.gm != null ? `毛利率 ${f1(m.gm)}%、` : ''}淨利率 ${f1(m.nm)}%、股東權益報酬率 ${f1(m.roe)}%（近 ${m.n} 年平均 ${f1(m.roeAvg)}%）`,
    `本益比 ${m.pe ? f1(m.pe) + ' 倍' : '無資料'}；近 ${m.span} 年營收年複合成長 ${f1(m.revCagr)}%${m.niCagr != null ? `、獲利年複合成長 ${f1(m.niCagr)}%` : ''}`];
  if (key === 'fisher' && m.rd != null) a.push(`研發費用占營收 ${f1(m.rd)}%`);
  return a;
}
export const BUY = {
  buffett: m => `巴菲特要的是「看得懂、長期賺得到錢、價格合理」。這家近 ${m.n} 年平均股東權益報酬率 ${f1(m.roeAvg)}%（最差的一年 ${f1(m.roeMin)}%），${m.niAllPos ? '每一年都獲利' : '期間曾出現虧損'}，營收 ${m.declines === 0 ? '沒有任何一年衰退' : '有 ' + m.declines + ' 年衰退'}；目前本益比 ${m.pe ? f1(m.pe) + ' 倍' : '無資料'}。`,
  lynch: m => m.peg != null
    ? `林區用 PEG 判斷「成長相對於價格划不划算」：本益比 ${f1(m.pe)} 倍 ÷ ${m.growthIsNi ? '獲利' : '營收'}年複合成長率 ${f1(m.growth)}% ＝ ${m.peg.toFixed(2)}。他的經驗是低於 1 划算、高於 2 偏貴。`
    : `近 ${m.span} 年${m.growthIsNi ? '獲利' : '營收'}年複合成長 ${f1(m.growth)}%，但本益比或成長率資料不足，無法計算 PEG。`,
  munger: m => `蒙格寧可用合理價買好公司，也不要用便宜價買普通公司。「好」的定義是報酬率高、而且年年都高：近 ${m.n} 年平均股東權益報酬率 ${f1(m.roeAvg)}%、最差的一年 ${f1(m.roeMin)}%，淨利率 ${f1(m.nm)}%${m.gmTrend != null ? `，毛利率較 ${m.span} 年前${m.gmTrend >= 0 ? '提高' : '下滑'} ${f1(Math.abs(m.gmTrend))} 個百分點` : ''}。`,
  fisher: m => `費雪找的是能長期成長、而且把利潤再投入研發的公司：近 ${m.span} 年營收年複合成長 ${f1(m.revCagr)}%${m.rd != null ? `，研發費用占營收 ${f1(m.rd)}%` : '（未揭露研發費用）'}${m.gmTrend != null ? `，毛利率較 ${m.span} 年前${m.gmTrend >= 0 ? '提高' : '下滑'} ${f1(Math.abs(m.gmTrend))} 個百分點` : ''}。費雪不太在意本益比，所以這裡不計入評分。`
};
export function risk(m, key) {
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
export const TAG = {
  buffett: m => `平均股東權益報酬率 ${f1(m.roeAvg)}%`,
  lynch: m => m.peg != null ? `PEG ${m.peg.toFixed(2)}` : `成長 ${f1(m.growth)}%`,
  munger: m => `報酬率年年不低於 ${f1(m.roeMin)}%`,
  fisher: m => `營收年複合成長 ${f1(m.revCagr)}%`
};
