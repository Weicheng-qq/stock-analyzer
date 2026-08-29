// 法說會 AI 分析 —— 消費 detect-events.mjs 產生的佇列
//
// 【設計原則】
// 1. Gemini 只負責「分析已經取得的資料」，絕不讓它去搜尋公司（那是 detect-events 的工作）。
// 2. 同一家公司、同一季度只分析一次：輸出檔 data/ai/gem_{代碼}_{季度}.json 已存在就跳過。
// 3. 依優先序處理 HIGH → MEDIUM → LOW，額度用完就停，HIGH 永遠先做。
// 4. 【零費用鐵則】只用 Gemini 免費層。免費層的行為是「超過額度直接拒絕」而不是「開始收費」，
//    所以只要那個 Google Cloud 專案「永遠不要啟用帳單(billing)」，就不可能產生任何費用。
//    ⚠️ 千萬不要在該專案啟用帳單：Gemini 一旦啟用帳單，免費層會整個消失、從第一個 token 就計費。
//    本腳本額外再加一層 MAX_ANALYSES 上限，避免把當日免費額度一次用光。
// 5. 所有財務數字必須來自官方原始資料，AI 只做整理與判讀；資料沒有的一律寫「未提供」。

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const AI_DIR = path.join(ROOT, 'data', 'ai');
const UA_TW = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

// 單次執行最多分析幾家（保守預設，避免一次吃光 Gemini 免費層的每日額度）
const MAX_ANALYSES = Number(process.env.MAX_ANALYSES || 40);
// DRY_RUN=1：完整跑一遍流程（抓官方資料、組提示詞、判斷跳過邏輯）但不呼叫 Gemini、不寫檔。
//   用途：沒有金鑰時驗證程式邏輯，或想先確認「這次會分析哪些公司」再實際執行。
const DRY_RUN = process.env.DRY_RUN === '1';
const KEY = process.env.GEMINI_KEY;
if (!KEY && !DRY_RUN) { console.error('❌ 未設定 GEMINI_KEY，中止（不會嘗試任何付費替代方案）'); process.exit(1); }

const rocToAd = y => Number(y) + 1911;
const num = v => { const n = Number(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : null; };
// 台股官方損益表單位是「仟元」，換算成「億元」比較好讀（符合專案的金額換算規則）
const toYi = v => { const n = num(v); return n == null ? null : (n / 100000).toFixed(2); };

async function getJson(url, ua = UA_TW) {
  for (let i = 0; i < 3; i++) {
    try { const r = await fetch(url, { headers: { 'User-Agent': ua } }); if (r.ok) return await r.json(); }
    catch (e) {}
    await new Promise(r => setTimeout(r, 1500 * (i + 1)));
  }
  return null;
}

// ── 取得台股全市場季度損益表（2 個請求換到 1900 家公司的官方數字）──
async function loadTwFinancials() {
  const map = {};
  const srcs = [
    { url: 'https://openapi.twse.com.tw/v1/opendata/t187ap06_L_ci', c: '公司代號', n: '公司名稱', y: '年度', s: '季別' },
    { url: 'https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap06_O_ci', c: 'SecuritiesCompanyCode', n: 'CompanyName', y: 'Year', s: 'Season' }
  ];
  for (const src of srcs) {
    const j = await getJson(src.url);
    if (!Array.isArray(j)) continue;
    for (const r of j) {
      const code = String(r[src.c] || '').trim();
      if (!/^\d{4}$/.test(code)) continue;
      map[code] = {
        name: r[src.n], year: rocToAd(r[src.y]), season: Number(r[src.s]),
        營業收入: toYi(r['營業收入']), 營業毛利: toYi(r['營業毛利（毛損）淨額'] ?? r['營業毛利（毛損）']),
        營業利益: toYi(r['營業利益（損失）']), 稅前淨利: toYi(r['稅前淨利（淨損）']),
        // ⚠️ 官方欄位名稱是「淨利（淨損）歸屬於母公司業主」，先前寫成「母公司業主（淨利／淨損）」
        //    抓不到值而一律變成 0.00（首次自動執行的 10 個檔都有這個問題）
        本期淨利: toYi(r['本期淨利（淨損）']), 母公司業主淨利: toYi(r['淨利（淨損）歸屬於母公司業主']),
        基本每股盈餘: num(r['基本每股盈餘（元）'])
      };
    }
  }
  return map;
}

function pct(a, b) { const x = num(a), y = num(b); return (x != null && y && y !== 0) ? (x / y * 100).toFixed(1) + '%' : '未提供'; }

function buildTwPrompt(code, f) {
  const 毛利率 = pct(f.營業毛利, f.營業收入), 營益率 = pct(f.營業利益, f.營業收入), 淨利率 = pct(f.本期淨利, f.營業收入);
  return `你是專業的財報分析師。以下是台股 ${f.name}（代碼 ${code}）${f.year} 年第 ${f.season} 季的官方財務數字，
來源為臺灣證券交易所／證券櫃檯買賣中心公開資訊（政府官方開放資料）。

【官方數字（單位：億元新台幣）】
營業收入：${f.營業收入 ?? '未提供'}
營業毛利：${f.營業毛利 ?? '未提供'}（毛利率 ${毛利率}）
營業利益：${f.營業利益 ?? '未提供'}（營業利益率 ${營益率}）
稅前淨利：${f.稅前淨利 ?? '未提供'}
本期淨利：${f.本期淨利 ?? '未提供'}（淨利率 ${淨利率}）
基本每股盈餘（EPS）：${f.基本每股盈餘 ?? '未提供'} 元

【鐵則 — 務必嚴格遵守】
1. 所有財務數字「只能」使用上方提供的官方數字，嚴禁自行推算、臆測或用你的訓練記憶補充。
2. 上方沒有提供的項目（例如自由現金流、資本支出、財測、法說會 Q&A），一律寫「未提供」，
   絕對不可以編造。這是最重要的一條，寧可留白也不能寫錯。
3. 一律使用繁體中文。金額用「億元」表示。
4. 若某項數字為負值，要明確指出是虧損，不可用成長率包裝（例如虧損收斂不等於轉盈）。
5. 若年增率因去年同期基期極低而失真，必須明講，並改用絕對金額描述。

只回傳 JSON，不要任何其他文字、不要 markdown：
{
 "revenue":"營收表現，引用官方數字，1-2句",
 "eps":"EPS 表現，引用官方數字，1-2句",
 "margins":"毛利率／營業利益率／淨利率的水準與意涵，引用上方算出的百分比，2-3句",
 "fcf":"自由現金流（官方季報損益表未提供此項，請寫「未提供」）",
 "capex":"資本支出（本資料未提供，請寫「未提供」）",
 "guidance":"財測／官方展望（本資料未提供，請寫「未提供」）",
 "outlook":"僅根據上方數字可合理說明的營運狀況，不得預測未來股價或營收，2-3句",
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
      const txt = j?.choices?.[0]?.message?.content || '';
      const m = txt.match(/\{[\s\S]*\}/);
      if (m) { try { return { result: JSON.parse(m[0]) }; } catch (e) {} }
    } catch (e) {}
  }
  return { failed: true };
}

// ── 主流程 ──
const qPath = path.join(ROOT, 'data', 'events', 'queue.json');
if (!fs.existsSync(qPath)) { console.error('❌ 找不到 data/events/queue.json，請先執行 detect-events.mjs'); process.exit(1); }
const { queue } = JSON.parse(fs.readFileSync(qPath, 'utf8'));

fs.mkdirSync(AI_DIR, { recursive: true });
const rank = { HIGH: 0, MEDIUM: 1, LOW: 2 };
const sorted = [...queue].sort((a, b) => rank[a.priority] - rank[b.priority]);

console.log(`▶ 佇列 ${sorted.length} 家，本次上限 ${MAX_ANALYSES} 家`);
const twFin = await loadTwFinancials();
console.log(`  已載入台股官方季度財務 ${Object.keys(twFin).length} 家`);

let done = 0, skipped = 0, failed = 0, stoppedByQuota = false;
for (const item of sorted) {
  if (done >= MAX_ANALYSES) { console.log(`⏸ 已達本次上限 ${MAX_ANALYSES} 家，其餘留待下次執行`); break; }
  if (item.market !== 'tw') continue;              // 美股走 SEC 抓原文，於後續階段接上（見 README）
  const f = twFin[item.symbol];
  if (!f || f.營業收入 == null) { skipped++; continue; }

  const key = `gem_${item.symbol}_${f.year}Q${f.season}`;
  const out = path.join(AI_DIR, `${key}.json`);
  if (fs.existsSync(out)) { skipped++; continue; }   // ★ 同一家同一季只分析一次

  const prompt = buildTwPrompt(item.symbol, f);
  if (DRY_RUN) {
    console.log(`  [DRY] ${item.symbol} ${f.name} ${f.year}Q${f.season} 提示詞 ${prompt.length} 字 營收${f.營業收入}億 EPS ${f.基本每股盈餘}`);
    done++; continue;
  }
  const r = await callGemini(prompt);
  if (r.rateLimited) {
    console.log('⏹ Gemini 免費額度已用盡，本次停止（不會切換到任何付費模式）');
    stoppedByQuota = true; break;
  }
  if (r.failed || !r.result) { failed++; console.log(`  ✗ ${item.symbol} ${f.name} 分析失敗`); continue; }

  fs.writeFileSync(out, JSON.stringify({
    key, symbol: item.symbol, name: f.name,
    quarter: `${f.year} 第${f.season}季`,
    source: '臺灣證券交易所／櫃買中心 公開資訊 OpenAPI（官方）',
    official: f, savedAt: new Date().toISOString(), result: r.result
  }, null, 1));
  done++;
  console.log(`  ✓ ${item.symbol} ${f.name} ${f.year}Q${f.season}`);
  // 免費層每分鐘請求數上限約 10 次。原本設 4.5 秒 ≒ 每分鐘 13 次，超過上限，
  //   首次自動執行時就在第 10 家觸發 429 而提前停止。改為 7 秒 ≒ 每分鐘 8.5 次，留安全餘裕。
  await new Promise(r => setTimeout(r, 7000));
}

console.log(`✅ 完成：新分析 ${done} 家、略過(已有或無官方數字) ${skipped} 家、失敗 ${failed} 家${stoppedByQuota ? '（因免費額度用盡提前結束）' : ''}`);
