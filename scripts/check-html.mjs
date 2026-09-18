// 上架前靜態檢查：專抓「瀏覽器會炸、但 node -e 檢查看不出來」的那幾類錯誤。
//
// ⚠️ 為什麼需要這支？
//   2026-09-18 我用 new Function(scriptBody) 檢查語法，回報 OK，實際打開卻是
//   SyntaxError: Invalid or unexpected token，整個 App 白畫面。
//   原因：程式碼裡有一行字串寫了完整的結束標籤字樣。HTML 解析器不管它在不在 JS
//   字串內，看到就把 <script> 區塊收在那裡，後面幾百行全部變成純文字。
//   new Function() 永遠看不到這個問題 —— 它拿到的已經是「切好的」字串，
//   而真正出錯的正是「怎麼切」。
//   所以檢查必須照著 HTML 解析器的規則做，而不是照著 JS 解析器的規則做。
//
// 用法：node scripts/check-html.mjs [檔案...]
import fs from 'fs';

const files = process.argv.slice(2);
if (!files.length) files.push('stock_analyzer.html', 'index.html');

const CLOSE = '<' + '/' + 'script';   // 這支自己也不能寫出完整字樣
let failed = 0;

function checkOne(path) {
  const problems = [];
  let html;
  try { html = fs.readFileSync(path, 'utf8'); }
  catch (e) { return { path, problems: ['讀不到檔案：' + e.message] }; }

  // ── ① 照 HTML 解析器的規則切出每一個 inline script 區塊 ──
  //   開始標籤之後，第一個出現的結束標籤字樣就是區塊結尾，字串引號完全不影響。
  const blocks = [];
  const openRe = /<script\b([^>]*)>/gi;
  let m;
  while ((m = openRe.exec(html))) {
    const attrs = m[1] || '';
    const bodyStart = m.index + m[0].length;
    const closeAt = html.toLowerCase().indexOf(CLOSE, bodyStart);
    if (closeAt < 0) { problems.push('有 <script> 沒有對應的結束標籤'); break; }
    const body = html.slice(bodyStart, closeAt);
    const line = html.slice(0, bodyStart).split('\n').length;
    if (!/\bsrc\s*=/i.test(attrs)) blocks.push({ body, line });
    openRe.lastIndex = closeAt;
  }

  // ── ② 每一塊都要能單獨通過 JS 語法檢查 ──
  //   切法對了，再檢查語法才有意義。
  blocks.forEach(b => {
    try { new Function(b.body); }
    catch (e) { problems.push('第 ' + b.line + ' 行起的 script 區塊語法錯誤：' + e.message); }
  });

  // ── ③ 區塊被提早切斷的徵兆 ──
  //   若某塊結尾看起來像被硬生生截斷（例如還在函式中間），上面的語法檢查就會抓到。
  //   這裡再補一個更直觀的訊號：正常頁面的 inline 區塊數量應該是固定的。
  if (blocks.length === 0) problems.push('找不到任何 inline script 區塊（檔案可能損毀）');

  // ── ④ 會讓 App 出事的疏漏（視為錯誤）──
  if (/\bdebugger\b/.test(html)) problems.push('殘留 debugger 陳述式');
  if (/navigator\.serviceWorker\.register/.test(html)) problems.push('又註冊了 Service Worker（曾造成無限重整）');
  const keys = html.match(/\b(sk-[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{30,}|gsk_[A-Za-z0-9]{20,})\b/g);
  if (keys) problems.push('疑似硬編金鑰 ' + keys.length + ' 筆');
  // 真正的混合內容：頁面自己「載入」的資源用 http。連結(href) 不算，那是開新分頁。
  const mixed = html.match(/\ssrc\s*=\s*["']http:\/\/(?!localhost|127\.)[^"']+/gi);
  if (mixed) problems.push('有 ' + mixed.length + ' 個以 http 載入的資源（WebView 會直接擋掉）');

  // ── ⑤ 值得知道、但不擋上架的（視為提醒）──
  const notes = [];
  // localhost 若包在「本機才用」的判斷式裡是正常的開發便利，線上不會走到。
  const lh = (html.match(/localhost:\d+/g) || []).length;
  if (lh) notes.push('出現 ' + lh + ' 處 localhost（若都在本機判斷式內則無妨，線上不會走到）');
  const httpLinks = (html.match(/href\s*=\s*["']http:\/\/(?!localhost|127\.)/gi) || []).length
                  + (html.match(/["']http:\/\/(?!localhost|127\.)[^"']*["']/g) || []).length;
  if (httpLinks) notes.push('有 ' + httpLinks + ' 個 http 開頭的對外連結（多為公司官網；部分在 WebView 可能被警告或開不起來）');

  return { path, problems, notes, blocks: blocks.length };
}

for (const f of files) {
  const r = checkOne(f);
  if (r.problems.length) {
    failed++;
    console.log('❌ ' + r.path);
    r.problems.forEach(p => console.log('   · ' + p));
  } else {
    console.log('✅ ' + r.path + '（inline script 區塊 ' + r.blocks + ' 個，全部通過）');
  }
  (r.notes || []).forEach(n => console.log('   ⓘ ' + n));
}

// ── ⑤ 兩檔一致鐵則 ──
if (files.includes('stock_analyzer.html') && files.includes('index.html')) {
  try {
    const a = fs.readFileSync('stock_analyzer.html');
    const b = fs.readFileSync('index.html');
    if (a.equals(b)) console.log('✅ stock_analyzer.html 與 index.html 完全一致');
    else { failed++; console.log('❌ 兩檔不一致：需要 cp stock_analyzer.html index.html'); }
  } catch (e) { failed++; console.log('❌ 無法比對兩檔：' + e.message); }
}

process.exit(failed ? 1 : 0);
