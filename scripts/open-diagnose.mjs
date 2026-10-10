// 台股開盤自動診斷 —— 用真的瀏覽器盯著正式站，看「使用者實際會看到的股價」對不對。
//
// 【為什麼需要】
//   台股報價出錯過很多次，每次都只能事後推測，因為出錯當下沒有任何紀錄。
//   2026-10-10 找到「盤中停在開盤價」的根本原因並修正，但當天是假日，沒辦法用真實盤中資料驗證。
//   使用者要求：「假設禮拜一我打開還是錯誤，你自己預埋抓 log 診斷原因，並寄到我的信箱」。
//
// 【做什麼】每個交易日開盤前後（約 08:58～09:25）：
//   ① 用無頭瀏覽器開正式站（手機尺寸），每 5 秒讀一次自選股畫面上「實際顯示」的價格與標示
//   ② 同一時刻直接問兩個資料來源（證交所 MIS、Yahoo股市）的原始欄位，當作對照的標準答案
//   ③ 比對：畫面有沒有停在開盤價、有沒有長時間與來源不符、有沒有出現異常標示
//   ④ 順便統計原始欄位，驗證我們對欄位的理解（z 是「-」的比例、pz 到底是什麼、Yahoo股市慢多少）
//   ⑤ 把 App 自己記的診斷紀錄（window.__quoteDiagDump）也抓回來
//   結果寫成一份中文報告，由 workflow 開成 GitHub Issue（GitHub 會寄 email 通知 repo 擁有者）。
//
// 【零費用】只用 GitHub Actions（public repo 免費）。約 2,500 次代理請求／天，遠低於 Cloudflare 每日 10 萬次。
//
// 本機測試：DIAG_TEST=1 node scripts/open-diagnose.mjs   （只取樣 60 秒，不管是不是盤中）
import fs from 'fs';
import { chromium } from 'playwright';

const SITE = (process.env.SITE_URL || 'https://weicheng-stock.pages.dev').replace(/\/+$/, '');
const TEST = process.env.DIAG_TEST === '1';
const SYMS = ['2330.TW', '2317.TW', '2454.TW', '2308.TW', '0050.TW', '8299.TWO'];
const NAMES = { '2330': '台積電', '2317': '鴻海', '2454': '聯發科', '2308': '台達電', '0050': '元大台灣50', '8299': '群聯' };
const STEP_MS = 5000;

const sleep = ms => new Promise(r => setTimeout(r, ms));
function tp() {   // 台北時間
  const s = new Date().toLocaleString('en-CA', { timeZone: 'Asia/Taipei', hour12: false });
  const hms = s.slice(12, 20).replace(/^24/, '00');
  const [h, m, sec] = hms.split(':').map(Number);
  return { ymd: s.slice(0, 10).replace(/-/g, ''), hms, min: h * 60 + m, sec: h * 3600 + m * 60 + sec };
}
const toSec = t => { const a = String(t || '').split(':').map(Number); return a.length >= 2 && a.every(Number.isFinite) ? a[0] * 3600 + a[1] * 60 + (a[2] || 0) : null; };
const num = v => { const x = parseFloat(v); return Number.isFinite(x) ? x : null; };
const proxied = u => SITE + '/api/proxy?url=' + encodeURIComponent(u);
async function getJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
async function truthMis() {
  const ex = SYMS.flatMap(s => { const c = s.replace(/\..*/, ''); return ['tse_' + c + '.tw', 'otc_' + c + '.tw']; }).join('|');
  const j = await getJson(proxied('https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=' + encodeURIComponent(ex) + '&json=1&delay=0'));
  const m = {};
  for (const r of (j.msgArray || [])) if (r && r.c) m[r.c] = { z: r.z, tz: r.trade ? r.trade.z : null, tt: r.trade ? r.trade.t : null, pz: r.pz, ts: r.ts, o: r.o, y: r.y, v: r.v, t: r.t, d: r.d };
  return m;
}
async function truthYtw() {
  const arr = await getJson(proxied('https://tw.stock.yahoo.com/_td-stock/api/resource/StockServices.stockList;symbols=' + SYMS.join('%2C')));
  const m = {};
  for (const x of (Array.isArray(arr) ? arr : [])) {
    const code = String(x.systexId || String(x.symbol || '').replace(/\..*/, ''));
    const raw = v => (v && typeof v === 'object' && v.raw !== undefined) ? v.raw : v;
    let rt = null; try { rt = new Date(x.regularMarketTime).toLocaleTimeString('en-GB', { timeZone: 'Asia/Taipei', hour12: false }); } catch (e) {}
    m[code] = { p: num(raw(x.price)), rt, delay: x.exchangeDataDelayedBy };
  }
  return m;
}

const out = { status: 'ok', title: '', report: '' };
function finish() {
  fs.writeFileSync('diag-report.md', out.report || '（無內容）');
  fs.writeFileSync('diag-title.txt', out.title || '台股開盤診斷');
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, 'status=' + out.status + '\n');
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, '# ' + out.title + '\n\n' + out.report + '\n');
  console.log('\n===== ' + out.title + ' =====\n' + out.report);
}

// ── 時間窗 ──
let now = tp();
if (!TEST) {
  if (now.min > 13 * 60 + 20) { out.status = 'skip'; out.title = '台股開盤診斷：已過盤中時段，未執行'; out.report = '啟動時間 ' + now.hms + '（台北），已超過 13:20。'; finish(); process.exit(0); }
  const startMin = 8 * 60 + 58;
  if (now.min < startMin) { const w = Math.min((startMin - now.min) * 60000, 45 * 60000); console.log('等待到 08:58（' + Math.round(w / 60000) + ' 分鐘）…'); await sleep(w); }
}
now = tp();
const today = now.ymd;
const startSec = now.sec;
const endSec = TEST ? startSec + 60 : Math.min(Math.max(9 * 3600 + 25 * 60, startSec + 20 * 60), 13 * 3600 + 25 * 60);

// ── 開瀏覽器（手機尺寸，台北時區）──
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 }, locale: 'zh-TW', timezoneId: 'Asia/Taipei',
  userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36 StockAnalyzerOpenDiagnose'
});
await ctx.addInitScript(syms => {
  try {
    localStorage.setItem('market', 'tw'); localStorage.setItem('marketPicked', '1');
    localStorage.setItem('watchlist_tw', JSON.stringify(syms.map(s => ({ symbol: s, name: s.replace(/\..*/, '') }))));
    sessionStorage.setItem('skipSplashOnce', '1');
  } catch (e) {}
}, SYMS);
const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(tp().hms + ' ' + String(e && e.message || e).slice(0, 200)));
let loadOk = true, loadMsg = '';
try {
  await page.goto(SITE + '/?opendiag=' + Date.now(), { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => window.__appReady === true && typeof quotesOf === 'function', null, { timeout: 60000 });
  await page.evaluate(() => { try { pickGroup(10); } catch (e) {} });
  await sleep(3000);
} catch (e) { loadOk = false; loadMsg = String(e && e.message || e).slice(0, 300); }

// ── 取樣 ──
const samples = [];   // {hms, sec, dom:{sym:{p,b}}, head, mis, ytw, eM, eY}
let sawToday = false;
while (loadOk) {
  const t = tp();
  if (t.sec >= endSec) break;
  if (!TEST && !sawToday && t.min >= 9 * 60 + 5 && samples.length) break;   // 09:05 還沒看到今天的資料 → 休市
  const s = { hms: t.hms, sec: t.sec, dom: {}, head: '', mis: null, ytw: null, eM: '', eY: '' };
  const [dom, mis, ytw] = await Promise.all([
    page.evaluate(syms => ({
      rows: syms.map(x => ({ s: x, p: (document.getElementById('wlp_' + x) || {}).textContent || '', b: ((document.getElementById('wlc_' + x) || {}).textContent || '').trim() })),
      head: (document.getElementById('wlLastUpdate') || {}).textContent || '', hidden: document.hidden
    }), SYMS).catch(e => ({ rows: [], head: '讀取畫面失敗：' + e.message })),
    truthMis().catch(e => { s.eM = String(e.message || e); return null; }),
    truthYtw().catch(e => { s.eY = String(e.message || e); return null; })
  ]);
  for (const r of dom.rows || []) s.dom[r.s.replace(/\..*/, '')] = { p: num(String(r.p).replace(/[^0-9.]/g, '')), b: r.b };
  s.head = dom.head; s.mis = mis; s.ytw = ytw;
  if (mis && Object.values(mis).some(r => r.d === today)) sawToday = true;
  samples.push(s);
  await sleep(Math.max(500, STEP_MS - (tp().sec - t.sec) * 1000));
}
let appDump = '';
if (loadOk) { try { appDump = await page.evaluate(() => (typeof __quoteDiagDump === 'function') ? __quoteDiagDump() : '（這個版本的 App 沒有診斷紀錄）'); } catch (e) { appDump = '讀取失敗：' + e.message; } }
await browser.close();

// ── 分析 ──
const L = [];
const dateTxt = today.slice(0, 4) + '-' + today.slice(4, 6) + '-' + today.slice(6, 8);
if (!loadOk) {
  out.status = 'bad'; out.title = '❌ 台股開盤診斷 ' + dateTxt + '：網站打不開';
  out.report = '無頭瀏覽器無法載入 ' + SITE + '：\n\n```\n' + loadMsg + '\n```\n'; finish(); process.exit(0);
}
if (!TEST && !sawToday) {
  out.status = 'skip'; out.title = '台股開盤診斷 ' + dateTxt + '：今日休市';
  out.report = '09:05 時證交所回傳的仍是上一個交易日的資料，判定今日休市，未做診斷。'; finish(); process.exit(0);
}

const problems = [], notes = [];
const BAD_BADGE = /未更新|資料異常|延遲報價|開盤價/;
const rowsMd = [];
const stat = { zDash: 0, zTot: 0, pzEqO: 0, pzEqTz: 0, pzN: 0, preOpen: [], snapLag: [], ytwLag: [], ytwEq: 0, ytwN: 0 };
for (const sym of SYMS) {
  const c = sym.replace(/\..*/, '');
  let longestMis = 0, runMis = 0, misFrom = '', misEx = '';
  let longestOpen = 0, runOpen = 0, openFrom = '';
  let blank = 0, live = 0, badge = {}, shownSet = new Set(), firstShown = null, lastShown = null;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i], d = s.dom[c] || {}, m = s.mis && s.mis[c], y = s.ytw && s.ytw[c];
    const trading = m && m.d === today && num(m.v) > 0;
    const truth = trading ? (num(m.z) ?? num(m.tz)) : null;
    // 原始欄位統計（只看連續交易時段 ts=0）
    if (trading && String(m.ts) === '0') {
      stat.zTot++; if (num(m.z) == null) { stat.zDash++; if (num(m.pz) != null) { stat.pzN++; if (num(m.pz) === num(m.o)) stat.pzEqO++; if (num(m.pz) === num(m.tz)) stat.pzEqTz++; } }
      const sl = s.sec - (toSec(m.t) ?? s.sec); stat.snapLag.push(sl);
      if (y && y.p != null && truth != null) { stat.ytwN++; if (y.p === truth) stat.ytwEq++; const yl = s.sec - (toSec(y.rt) ?? s.sec); stat.ytwLag.push(yl); }
    } else if (m && m.d === today && String(m.ts) === '1' && num(m.v) === 0 && stat.preOpen.length < 6) {
      stat.preOpen.push(s.hms + ' ' + c + ' z=' + m.z + ' pz=' + m.pz + ' o=' + m.o + ' y=' + m.y);
    }
    if (!trading) continue;
    live++;
    if (d.b) badge[d.b] = (badge[d.b] || 0) + (BAD_BADGE.test(d.b) || d.b === '—' ? 1 : 0);
    if (d.p == null) { blank++; runMis = 0; runOpen = 0; continue; }
    shownSet.add(d.p); if (firstShown == null) firstShown = d.p; lastShown = d.p;
    // 可接受的價格：前後各看幾筆取樣內，兩個來源給過的成交價（容許畫面比我們慢 15 秒、快 5 秒）
    const ok = new Set();
    for (let j = Math.max(0, i - 3); j <= Math.min(samples.length - 1, i + 1); j++) {
      const mj = samples[j].mis && samples[j].mis[c], yj = samples[j].ytw && samples[j].ytw[c];
      if (mj && mj.d === today) { const a = num(mj.z) ?? num(mj.tz); if (a != null) ok.add(a); }
      if (yj && yj.p != null) ok.add(yj.p);
    }
    if (ok.size && !ok.has(d.p)) { if (!runMis) { misFrom = s.hms; misEx = '畫面 ' + d.p + '，來源 ' + [...ok].join('/'); } runMis++; longestMis = Math.max(longestMis, runMis); } else runMis = 0;
    // 停在開盤價：畫面＝開盤價，但兩個來源的最後成交價都已經不是開盤價
    const o = num(m.o);
    if (o != null && d.p === o && truth != null && truth !== o && !(y && y.p === o)) { if (!runOpen) openFrom = s.hms; runOpen++; longestOpen = Math.max(longestOpen, runOpen); } else runOpen = 0;
  }
  const badB = Object.entries(badge).filter(([, n]) => n > 0).map(([k, n]) => k + '×' + n).join('、');
  const misS = longestMis * STEP_MS / 1000, openS = longestOpen * STEP_MS / 1000;
  if (openS >= 60) problems.push('**' + NAMES[c] + '（' + c + '）停在開盤價約 ' + openS + ' 秒**（從 ' + openFrom + ' 起）');
  if (misS >= 30) problems.push('**' + NAMES[c] + '（' + c + '）畫面與兩個來源都不符，持續約 ' + misS + ' 秒**（從 ' + misFrom + ' 起；' + misEx + '）');
  if (live && blank / live > 0.2) problems.push('**' + NAMES[c] + '（' + c + '）盤中有 ' + Math.round(blank / live * 100) + '% 的時間沒有顯示價格**');
  if (badB) notes.push(NAMES[c] + '（' + c + '）出現過標示：' + badB);
  rowsMd.push('| ' + NAMES[c] + ' ' + c + ' | ' + live + ' | ' + (firstShown ?? '—') + ' → ' + (lastShown ?? '—') + ' | ' + shownSet.size + ' | ' + (misS ? misS + ' 秒' : '0') + ' | ' + (openS ? openS + ' 秒' : '0') + ' | ' + (blank || 0) + ' | ' + (badB || '無') + ' |');
}
const eM = samples.filter(s => s.eM).length, eY = samples.filter(s => s.eY).length;
if (samples.length && eM / samples.length > 0.2) problems.push('**直接問證交所失敗 ' + eM + '/' + samples.length + ' 次**（例：' + (samples.find(s => s.eM) || {}).eM + '）');
if (samples.length && eY / samples.length > 0.2) notes.push('直接問 Yahoo股市失敗 ' + eY + '/' + samples.length + ' 次（例：' + (samples.find(s => s.eY) || {}).eY + '）');
if (pageErrors.length) problems.push('**網頁程式錯誤 ' + pageErrors.length + ' 筆**：' + pageErrors.slice(0, 3).join('；'));
const med = a => { if (!a.length) return null; const b = [...a].sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };
const mx = a => a.length ? Math.max(...a) : null;
if (mx(stat.snapLag) != null && med(stat.snapLag) > 60) problems.push('**證交所快照時間的中位數落後 ' + med(stat.snapLag) + ' 秒**（資料來源本身沒有在更新）');

const bad = problems.length > 0;
out.status = bad ? 'bad' : 'ok';
out.title = (TEST ? '【測試】' : '') + (bad ? '❌ ' : '✅ ') + '台股開盤診斷 ' + dateTxt + (bad ? '：發現 ' + problems.length + ' 個問題' : '：畫面股價正常');

L.push('取樣時間（台北）：**' + (samples[0] || {}).hms + ' ～ ' + (samples[samples.length - 1] || {}).hms + '**，共 ' + samples.length + ' 次（每 5 秒），網站：' + SITE);
if (TEST) L.push('', '> ⚠️ 這是**測試執行**（只取樣 60 秒、不限盤中），用來確認診斷流程與通知信能正常運作。非盤中時「盤中取樣」會是 0，屬正常。');
L.push('', '## 結論', '');
if (bad) { L.push('發現以下問題：', ''); problems.forEach(x => L.push('- ' + x)); }
else L.push('用真的瀏覽器開正式站，自選股 ' + SYMS.length + ' 檔在取樣期間**沒有停在開盤價**，畫面價格與資料來源相符。');
if (notes.length) { L.push('', '其他觀察：', ''); notes.forEach(x => L.push('- ' + x)); }
L.push('', '## 每一檔：畫面實際顯示 vs 資料來源', '',
  '| 股票 | 盤中取樣數 | 畫面價格（最早→最後） | 出現過幾種價格 | 與來源不符最長 | 停在開盤價最長 | 沒顯示價格次數 | 異常標示 |',
  '|---|---|---|---|---|---|---|---|', ...rowsMd);
L.push('', '## 原始欄位統計（驗證我們對欄位的理解）', '',
  '- 連續交易時段的取樣數：' + stat.zTot,
  '- 證交所 `z`（本筆快照成交價）是「-」的比例：' + (stat.zTot ? Math.round(stat.zDash / stat.zTot * 100) + '%（' + stat.zDash + '/' + stat.zTot + '）' : '無資料'),
  '- `z` 是「-」時，`pz` 等於**開盤價**的次數：' + stat.pzEqO + '/' + stat.pzN + '；等於**最後成交價 trade.z** 的次數：' + stat.pzEqTz + '/' + stat.pzN,
  '  - （2026-10-10 的修正假設：`pz` 是試算參考價、不是成交價。若「等於開盤價」明顯多於「等於最後成交價」，假設成立。）',
  '- 證交所快照時間落後：中位數 ' + (med(stat.snapLag) ?? '—') + ' 秒，最大 ' + (mx(stat.snapLag) ?? '—') + ' 秒',
  '- Yahoo股市 與證交所最後成交價相同的比例：' + (stat.ytwN ? Math.round(stat.ytwEq / stat.ytwN * 100) + '%（' + stat.ytwEq + '/' + stat.ytwN + '）' : '無資料'),
  '- Yahoo股市 成交時間落後：中位數 ' + (med(stat.ytwLag) ?? '—') + ' 秒，最大 ' + (mx(stat.ytwLag) ?? '—') + ' 秒（判斷它盤中是不是真的即時）',
  '- 直接問來源失敗次數：證交所 ' + eM + '、Yahoo股市 ' + eY + '（共 ' + samples.length + ' 次）');
if (stat.preOpen.length) L.push('', '開盤前試撮期間（`ts=1`）的原始欄位：', '', '```', ...stat.preOpen, '```');
// 台積電逐筆取樣（最多 80 筆），出問題時可以直接對照
const c0 = '2330';
L.push('', '<details><summary>台積電逐筆取樣（時間｜畫面｜標示｜證交所原始欄位｜Yahoo股市）</summary>', '', '```');
samples.slice(0, 80).forEach(s => { const d = s.dom[c0] || {}, m = s.mis && s.mis[c0], y = s.ytw && s.ytw[c0];
  L.push(s.hms + ' | 畫面 ' + (d.p ?? '—') + ' | ' + (d.b || '') + ' | ' + (m ? 'z=' + m.z + ' tz=' + m.tz + ' tt=' + m.tt + ' pz=' + m.pz + ' ts=' + m.ts + ' o=' + m.o + ' v=' + m.v + ' t=' + m.t : '✗' + s.eM) + ' | ' + (y ? y.p + '@' + y.rt + ' 延遲' + y.delay : '✗' + s.eY)); });
L.push('```', '', '</details>');
L.push('', '<details><summary>App 自己記的診斷紀錄（最後 80 行）</summary>', '', '```', ...String(appDump).split('\n').slice(0, 11), '…', ...String(appDump).split('\n').slice(11).slice(-80), '```', '', '</details>');
L.push('', '最後一次頂端時間列：`' + ((samples[samples.length - 1] || {}).head || '') + '`');
out.report = L.join('\n');
finish();
