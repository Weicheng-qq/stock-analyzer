// 把 IR_CALL_SUMMARY / IR_PRODUCTS_SUMMARY 從 HTML 抽成 data/ir/{代碼}.json，改為「用到才載入」
//
// 【為什麼要做】
// 這兩個常數佔了整份 JS 的 82%（合計 1.46MB）。它們被寫死在 HTML 裡，代表每個手機使用者
// 每次開 App 都要下載「全部 1423 家公司」的法說會全文，但實際上一次只會看其中一家。
// 公司數若照計畫成長到 5,000~6,000 家，HTML 會膨脹到 10MB 以上，手機直接不能用。
//
// 【保留內嵌的部分】
// - IR_QUARTERLY_PAGE（54KB）：logo 取用網域時會對「任意公司」同步查詢（自選股列表），
//   抽出去會讓 logo 失去一層來源，且它本來就小，留著。
// - IR_INDEX（新增，約 40KB）：只存 {代碼: 季度字串}，供 AI 快取鍵與「資料新鮮度」判斷用，
//   這兩件事必須同步取得、且不需要全文。
//
// 用法：node scripts/extract-ir.mjs        （會就地改寫 stock_analyzer.html）
//      node scripts/extract-ir.mjs --check （只檢查、不改檔）

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const HTML = path.join(ROOT, 'stock_analyzer.html');
const OUT = path.join(ROOT, 'data', 'ir');
const CHECK = process.argv.includes('--check');

const html = fs.readFileSync(HTML, 'utf8');

function span(name) {
  const i = html.indexOf('const ' + name);
  if (i < 0) throw new Error('找不到常數 ' + name);
  const st = html.indexOf('{', i);
  let d = 0, j = st;
  for (; j < html.length; j++) {
    if (html[j] === '{') d++;
    else if (html[j] === '}') { d--; if (d === 0) { j++; break; } }
  }
  return { declStart: i, bodyStart: st, end: j, src: html.slice(st, j) };
}

const callSpan = span('IR_CALL_SUMMARY');
const prodSpan = span('IR_PRODUCTS_SUMMARY');
const call = new Function('return ' + callSpan.src)();
const prod = new Function('return ' + prodSpan.src)();

console.log(`讀入 IR_CALL_SUMMARY ${Object.keys(call).length} 家、IR_PRODUCTS_SUMMARY ${Object.keys(prod).length} 家`);

const syms = [...new Set([...Object.keys(call), ...Object.keys(prod)])];
const index = {};
for (const s of syms) if (call[s]?.quarter) index[s] = call[s].quarter;

if (CHECK) {
  console.log(`--check：將產生 ${syms.length} 個 JSON、索引 ${Object.keys(index).length} 筆，未改動任何檔案`);
  process.exit(0);
}

fs.mkdirSync(OUT, { recursive: true });
let written = 0;
for (const s of syms) {
  // 檔名用代碼；代碼可能含 . 或 -（如 BRK.B），一律保留原樣，前端 fetch 時做 encodeURIComponent
  fs.writeFileSync(path.join(OUT, `${s}.json`), JSON.stringify({
    symbol: s,
    call: call[s] || null,
    products: prod[s] || null
  }));
  written++;
}
console.log(`已寫出 ${written} 個 data/ir/*.json`);

// ── 改寫 HTML：兩個大常數換成空物件 + 一份精簡索引 ──
// 由後往前取代，避免前面的取代讓後面的位置偏移
const idxJson = JSON.stringify(index);
const callReplacement = `{}; // ← 內容已抽到 data/ir/{代碼}.json，改由 ensureIR() 用到才載入（原本內嵌 837KB）
// 精簡索引：只保留「代碼→季度」，供 AI 快取鍵(__quarterTag)與資料新鮮度判斷同步使用，不含全文
const IR_INDEX = ${idxJson}`;

let out = html.slice(0, prodSpan.bodyStart)
  + `{}; // ← 內容已抽到 data/ir/{代碼}.json，改由 ensureIR() 用到才載入（原本內嵌 620KB）\nconst __IR_PRODUCTS_EXTRACTED = true`
  + html.slice(prodSpan.end);

const head = out.slice(0, callSpan.bodyStart);
const tail = out.slice(callSpan.end);
out = head + callReplacement + tail;

fs.writeFileSync(HTML, out, 'utf8');
console.log(`HTML：${(html.length / 1024 / 1024).toFixed(2)}MB → ${(out.length / 1024 / 1024).toFixed(2)}MB`);
