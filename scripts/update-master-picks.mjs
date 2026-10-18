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

import { TYPES, parseFin, metrics, SCORERS, total, money, facts, BUY, risk, TAG, f1 } from './lib/master-score.mjs';
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
  return parseFin(j);
}

// 指標、評分公式與套版文字：見 scripts/lib/master-score.mjs（App 前端共用同一份）

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
