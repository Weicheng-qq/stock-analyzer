// 每日市場資料產生器 —— 支援「今日必看 / 我的股票今日變化 / 昨天vs今天 / AI每日評分」
//
// 【設計原則：完全不動現有架構】
// 本腳本是「新增」的獨立檔案，不修改 detect-events.mjs / analyze-earnings.mjs 的任何邏輯，
// 只「讀取」它們的產出（data/events/queue.json、data/earnings/*.json）。
//
// 【成本控制（使用者最強調的一點）】
// 資料更新 → AI 分析一次 → 存成靜態 JSON → 所有使用者讀快取。
// 使用者無論重新整理幾次、有多少人同時使用，都不會多呼叫一次 AI。
// 五個評分面向裡，四個用「官方數字直接計算」（可重現、不會幻覺），
// 只有「新聞」這一項需要 AI 判讀 —— 這樣既省額度又更符合「以事實為依據」。
//
// 【AI 內容的鐵則（對應使用者第十一點）】
// 產出一律區分 fact（已確認事實，來自新聞標題/官方數字原文）與 inference（AI 推論），
// 前端以不同樣式呈現。AI 推論必須使用「市場預期／可能／有所提高」這類措辭，
// 不得寫成「一定會」這種確定性斷言。
//
// 【輸出】
//   data/daily/latest.json          今日必看 + 市場總結 + 本週事件
//   data/daily/scores/{代碼}.json   每日評分（保留昨日值以支援「昨天vs今天」）

import fs from 'node:fs';
import path from 'node:path';
// 複用既有模組取得 MOPS 法說會場次（含未來日期），不重寫一份
import { fetchCallIndex } from './lib/mops-earnings-call.mjs';
// 三層備援(Gemini→Groq→OpenRouter)，與網站 /api/ai 行為一致
import { callAI, aiStats, shouldStop } from './lib/ai-call.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const DAILY = path.join(ROOT, 'data', 'daily');
const SCORES = path.join(DAILY, 'scores');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const MAX_POOL = Number(process.env.DAILY_POOL || 60);      // 股票池上限
const MAX_AI = Number(process.env.DAILY_AI || 25);           // 本次最多幾次 AI 呼叫
const DRY_RUN = process.env.DRY_RUN === '1';
// 三把免費金鑰任一把有就能運作(與網站 /api/ai 相同的備援策略)
if (!process.env.GEMINI_KEY && !process.env.GROQ_KEY && !process.env.OPENROUTER_KEY && !DRY_RUN) {
  console.error('❌ 未設定任何 AI 金鑰(GEMINI_KEY/GROQ_KEY/OPENROUTER_KEY)，中止（不會嘗試任何付費方案）'); process.exit(1);
}

const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

async function getJson(url, ua = UA) {
  for (let i = 0; i < 3; i++) {
    try {
      const c = new AbortController(); const t = setTimeout(() => c.abort(), 20000);
      const r = await fetch(url, { headers: { 'User-Agent': ua }, signal: c.signal });
      clearTimeout(t);
      if (r.ok) return await r.json();
      if (r.status === 404) return null;
    } catch (e) {}
    await new Promise(r => setTimeout(r, 1200 * (i + 1)));
  }
  return null;
}

// ── 從現有 HTML 讀出常數（只讀不改；網站本體是單一 HTML，常數就寫在裡面）──
// ⚠️ 這些常數的形式不一：WATCH_DEFAULT 是 {us:[{symbol,name}...]}、TW_OTC 是 new Set([...])。
//    不能假設都是物件字面值，要從 `=` 之後整段取到該行結束的分號再求值。
const HTML_SRC = fs.readFileSync(path.join(ROOT, 'stock_analyzer.html'), 'utf8');
function readConst(name) {
  const i = HTML_SRC.indexOf('const ' + name);
  if (i < 0) return null;
  const eq = HTML_SRC.indexOf('=', i);
  // 從 = 後找出對應的結束位置：追蹤括號深度直到回到 0 且遇到分號
  let d = 0, j = eq + 1, started = false;
  for (; j < HTML_SRC.length; j++) {
    const c = HTML_SRC[j];
    if (c === '{' || c === '[' || c === '(') { d++; started = true; }
    else if (c === '}' || c === ']' || c === ')') { d--; }
    else if (c === ';' && d <= 0 && started) break;
  }
  try { return new Function('return (' + HTML_SRC.slice(eq + 1, j) + ')')(); } catch (e) { return null; }
}

// 台股代碼要加 Yahoo 後綴；上櫃用 .TWO
const TW_OTC = readConst('TW_OTC') || new Set();
const isOtc = c => (typeof TW_OTC.has === 'function') ? TW_OTC.has(c) : false;
// 代碼正規化：WATCH_DEFAULT 的台股是 '2330.TW' 這種帶後綴的形式，統一去掉後綴當內部代碼
const normCode = s => String(s || '').replace(/\.(TW|TWO)$/i, '');
const yahooSym = code => /^\d{4}$/.test(code) ? `${code}.${isOtc(code) ? 'TWO' : 'TW'}` : code.replace(/\./g, '-');

// ── 即時報價（Yahoo chart，與網站前端同一個免費來源）──
// ⚠️⚠️ 當日漲跌幅一定要用 `range=1d` 來算，這也是網站既有自選股的做法。
//   實測 `range=3mo` 時 `previousClose` 是 undefined，會退回 `chartPreviousClose`，
//   而那是「三個月前」的價格 —— 算出來變成三個月漲跌幅。
//   實際踩到：GOOGL 正確是 +1.74%，用 3mo 算出 -11.16%；台積電正確 +0.41%，算出 +5.45%。
//   顯示錯誤的漲跌幅會直接摧毀使用者信任，因此分成兩個請求：
//     ①range=1d → 當日漲跌（正確來源）  ②range=3mo → 均線與量能（只取歷史序列）
async function fetchQuote(code) {
  const sym = encodeURIComponent(yahooSym(code));
  const d1 = await getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?range=1d&interval=1d`);
  const m1 = d1?.chart?.result?.[0]?.meta;
  if (!m1) return null;
  const price = num(m1.regularMarketPrice), prev = num(m1.previousClose ?? m1.chartPreviousClose);
  if (price == null || prev == null || !prev) return null;

  await new Promise(r => setTimeout(r, 180));   // 同一檔的多個請求之間也要間隔，避免被 Yahoo 限流
  const j = await getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?range=3mo&interval=1d`);
  const r = j?.chart?.result?.[0];
  const m = r?.meta || m1;
  const closes = (r?.indicators?.quote?.[0]?.close || []).filter(x => x != null);
  const vols = (r?.indicators?.quote?.[0]?.volume || []).filter(x => x != null);
  const ma20 = closes.length >= 20 ? closes.slice(-20).reduce((a, b) => a + b, 0) / 20 : null;
  const ma60 = closes.length >= 60 ? closes.slice(-60).reduce((a, b) => a + b, 0) / 60 : null;
  const avgVol = vols.length >= 20 ? vols.slice(-20).reduce((a, b) => a + b, 0) / 20 : null;
  const todayVol = vols.length ? vols[vols.length - 1] : null;
  // ⚠️⚠️ 這筆漲跌到底屬於哪一個「交易日」，必須跟著資料一起存。
  //   週末與休市日排程照跑，拿到的是上一個交易日的收盤價；若前端一律寫「今日」，
  //   使用者星期日打開會以為今天市場有這些變動（實測 2026-08-30 週日就是這個狀況）。
  //   regularMarketTime 是 UTC 秒數，要加上該交易所的 gmtoffset 才是當地交易日。
  let tradeDate = null;
  try {
    const t = num(m1.regularMarketTime), off = num(m1.gmtoffset) ?? 0;
    if (t) tradeDate = new Date((t + off) * 1000).toISOString().slice(0, 10);
  } catch (e) {}
  return {
    name: m1.shortName || m1.longName || m.shortName || code,
    price, prev, changePct: (price - prev) / prev * 100, tradeDate,
    ma20, ma60, avgVol, todayVol,
    volRatio: (avgVol && todayVol) ? todayVol / avgVol : null,
    currency: m.currency || ''
  };
}

// ── 當日新聞（Yahoo search，與前端 fillNews 同一個來源）──
// ⚠️⚠️ 兩個關鍵修正，攸關「AI 不會胡亂推測」這條鐵則：
//  ①台股代碼查不到相關新聞：實測 `2330.TW` 回傳的是 Tillamook 乳製品公司的更正啟事等
//    完全無關的內容。若把這種新聞餵給 AI，會產出「台積電受乳製品消息影響」的荒謬結論。
//    → 台股一律先試美股 ADR 代碼（2330→TSM），沒有對應才用原代碼。
//  ②用 Yahoo 回傳的 `relatedTickers` 過濾：只保留真的與這檔股票相關的新聞。
//    寧可完全沒有新聞分數，也不能拿無關新聞硬湊。
const TW_US_EQUIV = readConst('TW_US_EQUIV') || {};
function newsQuerySymbols(code) {
  const out = [];
  if (/^\d{4}$/.test(code) && TW_US_EQUIV[code]) out.push(TW_US_EQUIV[code]);   // 雙掛牌優先用美股代碼
  out.push(yahooSym(code));
  if (!/^\d{4}$/.test(code)) out.push(code);
  return [...new Set(out)];
}
// 台股中文新聞：Yahoo 台股 RSS。實測 `tw.stock.yahoo.com/rss?s=2330.TW` 有 20 則當日中文新聞，
//   遠比英文的 finance search 適合台股（後者對台股代碼回傳的多是無關內容）。
// ⚠️ 但 RSS 會混入大盤與其他公司的新聞（實測 2330 的 RSS 裡出現「精材」「輝達」的報導），
//   因此必須用「公司中文名出現在標題裡」過濾，否則又會餵給 AI 不相關的素材。
const TW_ALL = readConst('TW_ALL') || {};
const TW_NAMES = readConst('TW_NAMES') || {};
// 台股中文名：TW_ALL 是全上市櫃對照表、TW_NAMES 另含 ETF。查不到就回 null，不硬湊。
const zhName = c => TW_ALL[c] || TW_NAMES[c] || null;
async function fetchNewsTw(code, limit = 6) {
  const name = TW_ALL[code];
  if (!name) return [];
  try {
    const r = await fetch(`https://tw.stock.yahoo.com/rss?s=${encodeURIComponent(yahooSym(code))}`, { headers: { 'User-Agent': UA } });
    if (!r.ok) return [];
    const xml = await r.text();
    const cutoff = Date.now() - 4 * 86400000;
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => {
      const g = re => { const x = m[1].match(re); return x ? x[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : ''; };
      return { title: g(/<title>([\s\S]*?)<\/title>/), link: g(/<link>([\s\S]*?)<\/link>/), time: Date.parse(g(/<pubDate>([\s\S]*?)<\/pubDate>/)) || 0, publisher: 'Yahoo 股市' };
    });
    return items
      .filter(x => x.title && (!x.time || x.time > cutoff))
      .filter(x => x.title.includes(name))   // 只留標題真的提到這家公司的
      .slice(0, limit);
  } catch (e) { return []; }
}

async function fetchNews(code, limit = 6) {
  const cutoff = Date.now() / 1000 - 3 * 86400;   // 只看近三天，確保「今日」的時效性
  const wanted = new Set([code, yahooSym(code), TW_US_EQUIV[code]].filter(Boolean).map(s => String(s).toUpperCase()));
  // 台股優先用中文 RSS（英文 search 對台股代碼幾乎抓不到相關新聞）
  if (/^\d{4}$/.test(code)) {
    const tw = await fetchNewsTw(code, limit);
    if (tw.length) return tw;
  }
  for (const q of newsQuerySymbols(code)) {
    const j = await getJson(`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&newsCount=${limit * 2}&quotesCount=0&lang=en-US&region=US`);
    const rows = (j?.news || [])
      .filter(n => !n.providerPublishTime || n.providerPublishTime > cutoff)
      // 只留 relatedTickers 真的包含本檔股票的新聞
      .filter(n => Array.isArray(n.relatedTickers) && n.relatedTickers.some(t => wanted.has(String(t).toUpperCase())))
      .map(n => ({ title: n.title, publisher: n.publisher, time: n.providerPublishTime, link: n.link }))
      .slice(0, limit);
    if (rows.length) return rows;
    await new Promise(r => setTimeout(r, 250));
  }
  return [];   // 查無相關新聞：新聞面不給分，不硬湊
}

// ── 本益比（估值面向用）──
// 沿用網站既有的 Yahoo fundamentals-timeseries 端點與 trailingPeRatio 欄位，
//   不另外找來源，確保與個股頁顯示的本益比同源、不會出現兩處數字打架。
async function fetchPe(code) {
  const sym = yahooSym(code);
  const now = Math.floor(Date.now() / 1000), p1 = now - 60 * 60 * 24 * 365 * 6;
  const j = await getJson(`https://query1.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(sym)}?symbol=${encodeURIComponent(sym)}&type=trailingPeRatio&period1=${p1}&period2=${now}`);
  const s = (j?.timeseries?.result || []).find(x => x.meta?.type?.[0] === 'trailingPeRatio');
  const pts = (s?.trailingPeRatio || []).filter(p => p?.reportedValue?.raw != null)
    .map(p => ({ d: p.asOfDate, v: p.reportedValue.raw }))
    .sort((a, b) => a.d.localeCompare(b.d));
  if (!pts.length) return null;
  const cur = pts[pts.length - 1].v;
  const vals = pts.map(p => p.v).filter(v => v > 0 && v < 500);   // 濾掉極端值(虧損期的PE無意義)
  if (!vals.length || !(cur > 0)) return null;
  return { cur, lo: Math.min(...vals), hi: Math.max(...vals) };
}

// ── 四個「可直接計算」的面向：不用 AI，可重現、不會幻覺 ──
function computeScores(q, earnings, pe) {
  const s = {};
  // 市場情緒：當日漲跌 + 量能
  let senti = 50 + clamp(q.changePct * 6, -30, 30);
  if (q.volRatio) senti += clamp((q.volRatio - 1) * 10, -8, 12);
  s.sentiment = Math.round(clamp(senti, 0, 100));
  // 技術面：站上均線與否 + 均線多空排列
  let tech = 50;
  if (q.ma20) tech += q.price > q.ma20 ? 12 : -12;
  if (q.ma60) tech += q.price > q.ma60 ? 12 : -12;
  if (q.ma20 && q.ma60) tech += q.ma20 > q.ma60 ? 8 : -8;
  s.technical = Math.round(clamp(tech, 0, 100));
  // 基本面：用官方季度損益表算獲利率（有 data/earnings 才給分，沒有就 null 不亂猜）
  const o = earnings?.official;
  if (o && num(o.營業收入)) {
    const rev = num(o.營業收入);
    const gm = num(o.營業毛利) != null ? num(o.營業毛利) / rev * 100 : null;
    const om = num(o.營業利益) != null ? num(o.營業利益) / rev * 100 : null;
    const nm = num(o.本期淨利) != null ? num(o.本期淨利) / rev * 100 : null;
    let f = 50;
    if (gm != null) f += clamp((gm - 25) * 0.7, -18, 22);
    if (om != null) f += clamp((om - 10) * 0.8, -15, 18);
    if (nm != null) f += clamp((nm - 8) * 0.8, -12, 15);
    s.fundamental = Math.round(clamp(f, 0, 100));
  } else s.fundamental = null;
  // 估值：本益比在近年區間中的相對位置——越接近區間低點分數越高。
  //   沒有本益比（虧損公司、ETF、資料缺漏）就給 null，不亂編一個數字出來。
  if (pe && pe.cur > 0 && pe.hi > pe.lo) {
    const pos = clamp((pe.cur - pe.lo) / (pe.hi - pe.lo), 0, 1);   // 0=區間低點, 1=區間高點
    s.valuation = Math.round(clamp(85 - pos * 60, 0, 100));
  } else s.valuation = null;
  return s;
}

// ── 重大異動偵測（Phase 2）──
// 全部依「可驗證的客觀條件」判斷，不讓 AI 自由發揮要不要示警。
function detectAlerts(q, earnings, ai, news) {
  const a = [];
  const p = Math.abs(q.changePct);
  if (p >= 7) a.push({ type: 'price', level: 'high', text: `股價${q.changePct >= 0 ? '大漲' : '大跌'} ${q.changePct.toFixed(2)}%` });
  else if (p >= 4) a.push({ type: 'price', level: 'mid', text: `股價${q.changePct >= 0 ? '明顯上漲' : '明顯下跌'} ${q.changePct.toFixed(2)}%` });
  if (q.volRatio && q.volRatio >= 2.5) a.push({ type: 'volume', level: 'high', text: `成交量放大至近月均量的 ${q.volRatio.toFixed(1)} 倍` });
  else if (q.volRatio && q.volRatio >= 1.8) a.push({ type: 'volume', level: 'mid', text: `成交量放大至近月均量的 ${q.volRatio.toFixed(1)} 倍` });
  // 新財報：⚠️ 不能只看「我們何時產生這份摘要」，那只代表排程剛好補到這家公司，
  //   不代表公司真的有新財報。實測 STRT 的財報期間結束於 2026-03-29（5個月前），
  //   卻因為摘要是今天產生的而被標成「重大異動」——這會誤導使用者以為今天發生了事情。
  //   必須「摘要是新產生的」且「財報期間本身也夠新」兩個條件同時成立。
  const perEnd = earnings?.official?.periodEnd ||
    (earnings?.official?.year && earnings?.official?.season ? `${earnings.official.year}-${String(earnings.official.season * 3).padStart(2, '0')}-01` : null);
  // ⚠️⚠️ 門檻從 100 天縮到 45 天（2026-08-30 實測後修正）。
  //   100 天太寬：台股 2026 第2季財報期間結束於 6/30，法定 8/14 前就公布了，
  //   但我們 8/30 才把摘要補建進來，結果 19 家台股同時被標成「今日重大異動」洗版。
  //   使用者要的是「公司真的發布了新財報」，不是「我們今天才去抓它的財報」。
  //   45 天有法規依據：台股季報法定申報期限為季後 45 天、美股 10-Q 約 40~45 天，
  //   所以「財報期間結束在 45 天內」才代表這份財報是剛出爐的。
  //   實測驗證：同一份資料下，100 天→21 檔示警；45 天→只剩 WSM(28天) 與 ADSK(30天)
  //   兩家真的剛公布財報的公司。
  const perFresh = perEnd ? (Date.now() - new Date(perEnd)) / 86400000 <= 45 : false;
  if (earnings?.savedAt && (Date.now() - new Date(earnings.savedAt)) / 86400000 <= 3 && perFresh) {
    a.push({ type: 'earnings', level: 'high', text: `最新財報摘要已更新（${earnings.quarter || ''}）` });
  }
  // 官方展望：只有真的取得逐字稿/新聞稿才示警
  if (earnings?.result?.guidanceOfficial && !/未提供|未於本次/.test(earnings.result.guidanceOfficial)) {
    a.push({ type: 'guidance', level: 'mid', text: '公司已公布官方財測／展望' });
  }
  // 新聞面：AI 判定重要程度 4 星以上才算重大
  if (ai && ai.importance >= 4 && news?.length) {
    a.push({ type: 'news', level: ai.importance >= 5 ? 'high' : 'mid', text: ai.fact || '出現重要新聞' });
  }
  return a;
}

// ── AI：只負責「新聞判讀」這一項，並嚴格區分事實與推論 ──
// ⚠️⚠️ 提示詞在 2026-08-30 重寫過一次。原因：使用者實測後回報
//   「這種內容一般投資人不容易理解，也不會產生每天回來看的動機」。
//   舊版產出的是財經報告體（實際例子：「此項設備取得可能顯示公司擴充產能或升級技術，
//   對未來營運有正面期待，但同時亦代表短期資金支出」）—— 又長又抽象。
//   新版強制拆成兩個一般人看得懂的問題：「今天為什麼動？」「對投資人代表什麼？」，
//   各限 40 字內、白話、禁止堆疊模糊措辭。
//   ⚠️ 欄位仍同時輸出舊的 fact/inference（個股頁「AI 每日更新」卡片在用），
//   值等同 why/meaning，確保既有畫面不會因為改欄位而壞掉。
async function aiNewsRead(code, name, q, news) {
  if (!news.length) return null;
  const list = news.map((n, i) => `${i + 1}. 「${n.title}」（來源：${n.publisher || '未標示'}）`).join('\n');
  const dir = q.changePct >= 0 ? '上漲' : '下跌';
  const prompt = `你是幫一般散戶看盤的分析師，說話要像跟朋友解釋，不要寫成研究報告。
以下是 ${name}（代碼 ${code}）近三日的新聞標題，以及今日股價變化。

【今日股價】${dir} ${Math.abs(q.changePct).toFixed(2)}%
【近三日新聞標題（原文，未經改寫）】
${list}

【鐵則 — 務必嚴格遵守】
1. 你只能根據上方新聞標題判讀，嚴禁引用標題以外的任何資訊，嚴禁用訓練記憶補充。
2. 如果上面的標題「無法解釋今天的股價變化」，why 就直接寫「今日無明確公司消息」，
   不要硬把不相關的新聞說成原因。寧可說不知道，也不要猜。
3. 一律使用繁體中文白話文。禁止使用「綜上所述」「值得留意的是」這類報告用語。
4. 不得預測股價、不得給目標價、不得建議買賣。

【寫法要求】
- why（今天為什麼動）：一句話、40 字內，講「發生了什麼事」，要具體，
  例如「拿下某客戶訂單」「法說會下修全年展望」，不要空泛地說「受市場關注」。
- meaning（對投資人代表什麼）：一句話、40 字內，講這件事為什麼重要。
  ⚠️「可能」「或許」「有機會」這類字最多出現一次，不可連續堆疊。
  真的無法判斷就回傳空字串，不要硬寫。

只回傳 JSON，不要任何其他文字、不要 markdown：
{
 "why":"今天為什麼動，一句話 40 字內",
 "meaning":"對投資人代表什麼，一句話 40 字內；無法判斷就給空字串",
 "stance":"pos 或 neu 或 neg —— 這則消息對這家公司偏正面／中性／偏負面",
 "newsScore":"0-100 的整數，代表近期新聞面偏正面(>50)或偏負面(<50)，中性給50",
 "importance":"1-5 的整數，代表這則資訊對投資人的重要程度"
}`;
  const r = await callGemini(prompt);
  if (!r) return null;
  const why = String(r.why || r.fact || '').slice(0, 120);
  const meaning = String(r.meaning || r.inference || '').slice(0, 120);
  const st = String(r.stance || '').toLowerCase().match(/pos|neg|neu/);
  return {
    why, meaning,
    fact: why, inference: meaning,          // 舊欄位名保留，個股頁沿用
    stance: st ? st[0] : null,
    newsScore: clamp(Math.round(num(r.newsScore) ?? 50), 0, 100),
    importance: clamp(Math.round(num(r.importance) ?? 3), 1, 5)
  };
}

const callGemini = callAI;   // 改用共用的三層備援
let rateLimited = false;

// 綜合評分：把各面向加權平均（null 的面向不計入，不用預設值硬湊）
function overall(s) {
  const w = { fundamental: 0.3, news: 0.22, technical: 0.22, sentiment: 0.18, valuation: 0.08 };
  let sum = 0, wsum = 0;
  for (const k of Object.keys(w)) if (s[k] != null) { sum += s[k] * w[k]; wsum += w[k]; }
  return wsum ? Math.round(sum / wsum) : null;
}

// ── 【Phase 3】本週重要事件 ──
// ⚠️ 誠實區分兩種來源，前端會用不同標示呈現：
//   confirmed＝官方已公告的確定日期（MOPS 法說會場次、法定申報期限）
//   scheduled＝依固定慣例推算（美國非農＝每月第一個週五等），標明是推算不是官方公告
// ⚠️ 美股個別公司的財報日期：Yahoo 相關端點（quoteSummary / v7 quote）現已全部需要
//   crumb 驗證，免費拿不到。因此本清單不包含美股公司財報日，不用猜的硬湊。
function weekEvents(twCalls) {
  const out = [];
  const now = new Date();
  const end = new Date(now); end.setDate(end.getDate() + 7);
  const fmt = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const inRange = d => d >= new Date(now.getFullYear(), now.getMonth(), now.getDate()) && d <= end;

  // ① 台股法說會（MOPS 官方公告的場次，含未來日期）—— 確定事實
  for (const [code, info] of (twCalls || new Map())) {
    const m = String(info.date || '').match(/^(\d{3})\/(\d{2})\/(\d{2})/);   // 民國年
    if (!m) continue;
    const d = new Date(Number(m[1]) + 1911, Number(m[2]) - 1, Number(m[3]));
    if (!inRange(d)) continue;
    out.push({ date: fmt(d), kind: 'confirmed', category: '法說會', symbol: code, name: info.name || zhName(code) || code, title: `${info.name || code} 法人說明會`, note: (info.summary || '').slice(0, 60) });
  }

  // ② 台股月營收：證交法規定每月 10 日前公告上月營收 —— 法定期限，屬確定
  const tenth = new Date(now.getFullYear(), now.getMonth(), 10);
  if (inRange(tenth)) out.push({ date: fmt(tenth), kind: 'confirmed', category: '月營收', symbol: null, title: '台股上市櫃公司月營收公告期限', note: '依規定每月 10 日前公告上月營收' });

  // ③ 美國主要經濟數據：規則明確且長期穩定者才列，日期會變動的（CPI/FOMC）一律不猜
  const firstBiz = (y, mo) => { const d = new Date(y, mo, 1); while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1); return d; };
  const firstFri = (y, mo) => { const d = new Date(y, mo, 1); while (d.getDay() !== 5) d.setDate(d.getDate() + 1); return d; };
  for (const mo of [now.getMonth(), now.getMonth() + 1]) {
    const y = now.getFullYear();
    const ism = firstBiz(y, mo);
    if (inRange(ism)) out.push({ date: fmt(ism), kind: 'scheduled', category: '經濟數據', symbol: null, title: '美國 ISM 製造業指數', note: '依慣例為每月第一個工作日，非官方公告日期' });
    const nfp = firstFri(y, mo);
    if (inRange(nfp)) out.push({ date: fmt(nfp), kind: 'scheduled', category: '經濟數據', symbol: null, title: '美國非農就業報告', note: '依慣例為每月第一個週五，非官方公告日期' });
    const adp = new Date(nfp); adp.setDate(adp.getDate() - 2);
    if (inRange(adp)) out.push({ date: fmt(adp), kind: 'scheduled', category: '經濟數據', symbol: null, title: '美國 ADP 就業報告', note: '依慣例為非農前的週三，非官方公告日期' });
  }

  // ④ 既有 IR 常數裡公司自己預告的財報日（數量少，但屬官方預告）
  try {
    const dir = path.join(ROOT, 'data', 'ir');
    for (const f of fs.readdirSync(dir)) {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      const m = String(j.call?.quarter || '').match(/將於\s*(20\d\d)[\/\-](\d{1,2})[\/\-](\d{1,2})/);
      if (!m) continue;
      const d = new Date(+m[1], +m[2] - 1, +m[3]);
      if (!inRange(d)) continue;
      out.push({ date: fmt(d), kind: 'confirmed', category: '財報', symbol: j.symbol, title: `${j.symbol} 財報公布`, note: '公司於前次財報中預告' });
    }
  } catch (e) {}

  return out.sort((a, b) => a.date.localeCompare(b.date) || a.category.localeCompare(b.category)).slice(0, 40);
}

// ── 主流程 ──
const today = todayStr();
console.log(`▶ 每日市場資料產生（${today}）`);
fs.mkdirSync(SCORES, { recursive: true });

// 1) 組股票池：預設自選股 + 今日有事件的公司 + 已有財報摘要的公司
const WATCH_DEFAULT = readConst('WATCH_DEFAULT') || {};
const pool = new Set();
// ⚠️ WATCH_DEFAULT 的元素是 {symbol,name} 物件，且台股帶 .TW 後綴，要取 .symbol 再正規化
for (const arr of Object.values(WATCH_DEFAULT)) {
  for (const it of (arr || [])) {
    const c = normCode(typeof it === 'string' ? it : (it && it.symbol));
    if (c) pool.add(c);
  }
}
try {
  const q = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'events', 'queue.json'), 'utf8'));
  for (const it of (q.queue || []).filter(x => x.priority === 'HIGH')) pool.add(it.symbol);
} catch (e) {}
try {
  for (const f of fs.readdirSync(path.join(ROOT, 'data', 'earnings')).filter(f => f.endsWith('.json'))) {
    if (pool.size >= MAX_POOL) break;
    pool.add(f.replace(/\.json$/, ''));
  }
} catch (e) {}
const codes = [...pool].slice(0, MAX_POOL);
console.log(`  股票池 ${codes.length} 檔（預設自選股 + 今日事件股 + 已有財報摘要者）`);

// 2) 逐檔取報價 + 計算可算的面向
const rows = [];
for (const code of codes) {
  const q = await fetchQuote(code);
  if (!q) continue;
  let earn = null;
  try { earn = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'earnings', `${code}.json`), 'utf8')); } catch (e) {}
  await new Promise(r => setTimeout(r, 180));
  const pe = await fetchPe(code);          // 估值面向；取不到就 null，不亂編
  rows.push({ code, q, earn, pe, base: computeScores(q, earn, pe) });
  // ⚠️ 每檔現在要發 3 個 Yahoo 請求（當日報價／3個月序列／本益比）。
  //   原本間隔 220ms 等於每秒約 13 個請求，實測 60 檔時被限流，
  //   股票池從 31 檔掉到只剩 12 檔。放慢到 600ms（每秒約 5 個請求）。
  await new Promise(r => setTimeout(r, 600));
}
console.log(`  取得報價 ${rows.length} 檔`);

// 3) 依「值得關注程度」排序，AI 額度優先給變化最大的
rows.sort((a, b) => Math.abs(b.q.changePct) - Math.abs(a.q.changePct));

// 4) AI 新聞判讀（只給前 MAX_AI 檔，額度用盡即停）
let aiUsed = 0;
for (const r of rows) {
  if (aiUsed >= MAX_AI || shouldStop()) break;
  // 變化太小且無事件的就不花額度
  if (Math.abs(r.q.changePct) < 1.2 && aiUsed > 8) continue;
  const news = await fetchNews(r.code);
  if (!news.length) continue;
  if (DRY_RUN) { r.ai = { fact: '(DRY)', inference: '(DRY)', newsScore: 50, importance: 3 }; r.news = news; aiUsed++; continue; }
  const ai = await aiNewsRead(r.code, r.q.name, r.q, news);
  if (ai) { r.ai = ai; r.news = news; aiUsed++; }
  await new Promise(x => setTimeout(x, 7000));   // 免費層每分鐘約 10 次，7 秒留餘裕
}
console.log(`  AI 新聞判讀 ${aiUsed} 檔（Gemini ${aiStats.gemini}／Groq ${aiStats.groq}／OpenRouter ${aiStats.openrouter}，失敗 ${aiStats.failed}）`);

// 5) 寫出每檔評分（保留昨日值，供「昨天vs今天」使用）
for (const r of rows) {
  const s = { ...r.base, news: r.ai ? r.ai.newsScore : null };
  const score = overall(s);
  const f = path.join(SCORES, `${r.code}.json`);
  let prev = null;
  try { const old = JSON.parse(fs.readFileSync(f, 'utf8')); if (old.date !== today) prev = { date: old.date, score: old.score, scores: old.scores }; else prev = old.prev || null; } catch (e) {}
  fs.writeFileSync(f, JSON.stringify({
    symbol: r.code, name: r.q.name, nameZh: zhName(r.code), date: today, tradeDate: r.q.tradeDate || null,
    price: r.q.price, changePct: Number(r.q.changePct.toFixed(2)),
    volRatio: r.q.volRatio ? Number(r.q.volRatio.toFixed(2)) : null,
    score, scores: s,
    pe: r.pe ? { cur: Number(r.pe.cur.toFixed(1)), lo: Number(r.pe.lo.toFixed(1)), hi: Number(r.pe.hi.toFixed(1)) } : null,
    alerts: detectAlerts(r.q, r.earn, r.ai, r.news),
    ai: r.ai || null,
    newsTop: (r.news || []).slice(0, 3).map(n => ({ title: n.title, publisher: n.publisher, link: n.link })),
    prev,
    generatedAt: new Date().toISOString()
  }, null, 1));
}

// 6) 今日必看：有 AI 判讀者依「重要程度 × 漲跌幅」排序取前 5
// ⚠️ 排除「AI 自己說沒有相關新聞」的項目：實測出現過一則內容是
//   「事實：近期無明確相關新聞／判讀：缺乏具體營運數據…」卻被放進今日必看，
//   對使用者毫無價值。沒有實質內容就不該佔版面。
const NO_CONTENT = /無明確相關新聞|無相關新聞|資訊不足|未提供/;
const musts = rows.filter(r => r.ai && !NO_CONTENT.test(r.ai.fact || ''))
  .map(r => ({
    symbol: r.code, name: r.q.name, nameZh: zhName(r.code), tradeDate: r.q.tradeDate || null,
    changePct: Number(r.q.changePct.toFixed(2)),
    price: r.q.price, currency: r.q.currency,
    fact: r.ai.fact, inference: r.ai.inference,
    why: r.ai.why, meaning: r.ai.meaning, stance: r.ai.stance, newsScore: r.ai.newsScore,
    importance: r.ai.importance,
    score: overall({ ...r.base, news: r.ai.newsScore }),
    link: (r.news || [])[0]?.link || null
  }))
  .sort((a, b) => (b.importance - a.importance) || (Math.abs(b.changePct) - Math.abs(a.changePct)))
  .slice(0, 5);

// 7) 今日市場總結 ＋ 市場焦點主題 ＋ 今天要注意什麼
// ⚠️⚠️ 成本：這三樣是「同一次 AI 呼叫」一起產出的，呼叫次數與改版前完全相同（1 次），
//   沒有新增任何 API、沒有新增任何費用。素材只用上面已經查證過的事實，不另外抓資料。
// ⚠️ 主題與注意事項若無法從當日素材歸納，一律回傳空陣列 —— 前端會整塊不顯示，
//   絕不為了「每天都要有內容」而讓 AI 憑空生出固定主題（使用者明確要求）。
let summary = null, themes = [], watchpoints = [];
if (!DRY_RUN && !shouldStop() && musts.length) {
  // 素材＝今天所有取得 AI 判讀且有實質內容的個股（不只前 5 名，主題才歸納得出來）
  const material = rows.filter(r => r.ai && !NO_CONTENT.test(r.ai.fact || '')).slice(0, 12)
    .map(r => `${zhName(r.code) || r.q.name}(${r.code}) ${r.q.changePct >= 0 ? '+' : ''}${r.q.changePct.toFixed(2)}%：${r.ai.fact}`)
    .join('\n');
  const r = await callGemini(`以下是今日市場中，各檔股票「已查證的新聞重點」與當日漲跌（皆為已取得的事實，不可添加其他資訊）：
${material}

請產出三樣東西，全部用繁體中文白話文，讓一般投資人 1 分鐘看懂。不要寫成研究報告。

1. summary：今日市場總結，50～80 字。講「今天市場發生什麼」，不要預測後市、不要建議買賣。

2. themes：今天市場真正的焦點主題，最多 5 個，寧缺勿濫。
   - name：2～8 字的**產業／族群／題材**名稱，例如「AI／半導體」「記憶體」「金融」「減重藥」。
   - why：一句話、30 字內，說明「今天為什麼值得注意」，要講出原因，
     不可只寫「受到關注」「市場熱門」這種等於沒說的話。
   - ⚠️⚠️ **主題必須是族群層級，不可以是單一公司的事件描述。**
     「設備投資」「營運展望弱化」「公司治理更正」這種都是錯的——那只是把某一檔股票的
     新聞換句話說，和前面的個股清單完全重複，讀者等於看了兩次同樣的東西。
   - ⚠️ 一個族群至少要有兩家以上公司出現相關消息，才算得上是「市場主題」。
     只有一家公司有消息就不要列。**寧可只回 1～2 個真正的主題，也不要湊到 5 個。**
   - ⚠️ 主題必須是從上方內容真正歸納出來的，上方沒出現的一律不准寫。
     歸納不出來就直接回傳空陣列 []，那是可以接受的答案。

3. watchpoints：接下來要觀察什麼，最多 3 條，每條 25 字內。
   - 必須直接對應上方出現過的事實（例如某公司財測、某族群的訂單消息）。
   - ⚠️ 不得寫成買賣建議、不得預測漲跌、不得出現目標價。
     無法從上方內容導出就回傳空陣列 []。

只回傳 JSON，不要 markdown：
{"summary":"...","themes":[{"name":"...","why":"..."}],"watchpoints":["...","..."]}`);
  if (r) {
    if (r.summary) summary = String(r.summary).slice(0, 220);
    if (Array.isArray(r.themes)) {
      themes = r.themes
        .filter(t => t && t.name)
        .map(t => ({ name: String(t.name).slice(0, 12), why: String(t.why || '').slice(0, 60) }))
        .slice(0, 5);
    }
    if (Array.isArray(r.watchpoints)) {
      watchpoints = r.watchpoints
        .map(w => String(typeof w === 'string' ? w : (w && (w.text || w.title)) || '').trim())
        .filter(Boolean).map(w => w.slice(0, 50)).slice(0, 3);
    }
  } else console.warn('⚠️ 市場總結／主題未產生（三層 AI 都沒回傳有效結果）');
}

// 重大異動彙總：只收 level=high 者，避免變成雜訊（使用者要求「重大事件才通知」）
const alerts = rows.map(r => ({ symbol: r.code, name: r.q.name, nameZh: zhName(r.code), changePct: Number(r.q.changePct.toFixed(2)),
    items: detectAlerts(r.q, r.earn, r.ai, r.news).filter(a => a.level === 'high') }))
  .filter(x => x.items.length)
  .sort((a, b) => b.items.length - a.items.length || Math.abs(b.changePct) - Math.abs(a.changePct));

// 本週重要事件（Phase 3）
let events = [];
try {
  const twCalls = await fetchCallIndex(2);   // 近兩個月的法說會場次，含未來日期
  events = weekEvents(twCalls);
  console.log(`  本週重要事件 ${events.length} 筆`);
} catch (e) { console.warn('⚠️ 本週事件產生失敗（不影響其他功能）'); }

// 整份資料的交易日＝各檔裡最新的那一個（同一天內各市場可能不同，取最新者代表「這份資料的最新交易日」）
const tradeDate = rows.map(r => r.q.tradeDate).filter(Boolean).sort().pop() || null;

fs.writeFileSync(path.join(DAILY, 'latest.json'), JSON.stringify({
  date: today,
  tradeDate,
  alerts,
  events,
  generatedAt: new Date().toISOString(),
  summary,
  themes,
  watchpoints,
  musts,
  poolSize: rows.length,
  aiUsed,
  aiSource: { gemini: aiStats.gemini, groq: aiStats.groq, openrouter: aiStats.openrouter, failed: aiStats.failed },
  note: 'fact＝新聞標題明確講到的已確認事實；inference＝AI 推論，僅供參考，非確定性預測。'
}, null, 1));

console.log(`✅ 完成：今日必看 ${musts.length} 則、評分 ${rows.length} 檔、重大異動 ${alerts.length} 檔、市場總結 ${summary ? '已產生' : '未產生'}`);
