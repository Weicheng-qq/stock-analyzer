// 用無頭瀏覽器從「公司官網投資人關係(IR)頁」抓法說會逐字稿／簡報
//
// 【為什麼需要瀏覽器而不是單純 fetch】
// 實測同一批 21 家美股：
//   純 fetch    → 頁面成功 67%、找到 PDF 44%、找到逐字稿 22%
//   無頭瀏覽器  → 頁面成功 81%、找到 PDF 71%、找到逐字稿 38%
// 差別在於現代 IR 網站多半是 JavaScript 動態渲染（NVIDIA 用純 fetch 抓到 0 個 PDF，
// 用瀏覽器抓到 10 個 PDF 含逐字稿），而且瀏覽器能通過多數機器人檢查。
//
// 【為什麼要做這個】
// 使用者最在乎法說會品質要達到「人工逐間抓公司官網」的水準——那個水準來自
// 完整逐字稿裡的管理層原話（例如台積電魏哲家談 AI 成長「比之前更強」），
// 這是 SEC 8-K 新聞稿與財務數字都給不了的。實測台積電逐字稿 68,460 字、
// NVIDIA 63,399 字，含完整分析師問答，正是人工版的來源。
//
// 【天花板（誠實說明）】
// 約 19% 的公司（亞培、金百利、洛克希德、康卡斯特等）連無頭瀏覽器都被擋，
// 屬 Akamai 等級的防護（專案文件記載的 TSLA/LLY 同一類）。試過關閉 HTTP/2 反而更糟。
// 另外中小型公司本來就多半不公開逐字稿。這些情況一律優雅退回 SEC 8-K 新聞稿。

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const execFileP = promisify(execFile);
const PDFTOTEXT = process.env.PDFTOTEXT_BIN || 'pdftotext';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// 文件優先序：逐字稿 > 法說會簡報 > 財報新聞稿。逐字稿含管理層問答，資訊量最高。
const DOC_RANK = [
  { re: /transcript|逐字稿/i, kind: 'transcript', rank: 0 },
  { re: /presentation|slides|簡報|earnings.?deck/i, kind: 'presentation', rank: 1 },
  { re: /earnings.?release|press.?release|新聞稿|results/i, kind: 'release', rank: 2 }
];

let _browser = null, _ctx = null, _pwFailed = false;

// 瀏覽器只開一次、整輪共用（每次開關約要數秒，逐家開會拖垮執行時間）
async function getContext() {
  if (_pwFailed) return null;
  if (_ctx) return _ctx;
  try {
    const { chromium } = await import('playwright-core');
    _browser = await chromium.launch({ headless: true });
    _ctx = await _browser.newContext({ userAgent: UA, locale: 'en-US', viewport: { width: 1280, height: 900 } });
    return _ctx;
  } catch (e) {
    _pwFailed = true;
    console.warn('⚠️ 無法啟動無頭瀏覽器，IR 逐字稿路徑略過（會退回 SEC 新聞稿）：', (e.message || '').split('\n')[0]);
    return null;
  }
}
export async function closeBrowser() {
  try { if (_browser) await _browser.close(); } catch (e) {}
  _browser = null; _ctx = null;
}

// ⚠️ 檔案一定要用「頁面內的 fetch」下載，不能用 Playwright 的 ctx.request。
//   實測台積電對 ctx.request 一律回 403（不管帶 Referer、Accept、Sec-Fetch-* 什麼標頭都一樣），
//   因為那不是真正由瀏覽器發出的請求。改在頁面 JS 環境內 fetch，指紋與 cookie 完全一致，
//   同一個檔案就順利拿到 1.47MB 的 PDF。
//   但頁面內 fetch 受 CORS 限制：很多公司的 PDF 放在 CDN（NVIDIA 在 q4cdn.com），
//   跨網域就會被瀏覽器擋下。兩種方式剛好互補，因此依序都試：
//     ①頁面內 fetch（同網域、擋 API 請求的站，如台積電）
//     ②Playwright 的 ctx.request（跨網域 CDN，如 NVIDIA/Deere/3M）
async function downloadDoc(ctx, page, url, referer) {
  const viaPage = await downloadInPage(page, url);
  if (viaPage) return viaPage;
  try {
    const r = await ctx.request.get(url, { timeout: 60000, headers: { Referer: referer } });
    if (!r.ok()) return null;
    const b = await r.body();
    return (b && b.length > 5000) ? b : null;
  } catch (e) { return null; }
}

async function downloadInPage(page, url) {
  const res = await page.evaluate(async (u) => {
    try {
      const r = await fetch(u, { credentials: 'include' });
      if (!r.ok) return { err: 'HTTP ' + r.status };
      const bytes = new Uint8Array(await r.arrayBuffer());
      if (bytes.length > 40 * 1024 * 1024) return { err: 'too large' };
      // 大檔一次 String.fromCharCode 會爆堆疊，分塊處理
      let s = ''; const CH = 0x8000;
      for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
      return { b64: btoa(s), len: bytes.length };
    } catch (e) { return { err: String((e && e.message) || e) }; }
  }, url);
  if (!res || res.err) return null;
  return Buffer.from(res.b64, 'base64');
}

async function pdfToText(buf) {
  if (!buf || buf.length < 5000 || buf.subarray(0, 4).toString() !== '%PDF') return null;
  let p = '', t = '';
  try {
    p = path.join(os.tmpdir(), `ir_${Date.now()}_${Math.random().toString(36).slice(2)}.pdf`);
    t = p.replace(/\.pdf$/, '.txt');
    fs.writeFileSync(p, buf);
    await execFileP(PDFTOTEXT, ['-enc', 'UTF-8', p, t], { timeout: 90000 });
    const txt = fs.readFileSync(t, 'utf8').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    return txt.length > 800 ? txt : null;
  } catch (e) { return null; }
  finally { for (const f of [p, t]) { try { if (f) fs.unlinkSync(f); } catch (e) {} } }
}

// 從 IR 頁找出最相關的一份文件並取出全文
export async function fetchIrDocument(symbol, irUrl) {
  if (!irUrl) return null;
  const ctx = await getContext();
  if (!ctx) return null;
  const page = await ctx.newPage();
  try {
    await page.goto(irUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
    await page.waitForTimeout(2500);   // 等 JS 把文件連結渲染出來（這正是純 fetch 拿不到的部分）
    const links = await page.evaluate(() =>
      [...document.querySelectorAll('a[href]')].map(a => ({ text: (a.textContent || '').trim().slice(0, 120), href: a.href })));

    // 只要 PDF；依「逐字稿 > 簡報 > 新聞稿」排序，同類取頁面上較前者（通常是最新一季）
    const cands = [];
    for (const l of links) {
      if (!/\.pdf(\?|$)/i.test(l.href)) continue;
      const blob = `${l.href} ${l.text}`;
      const hit = DOC_RANK.find(d => d.re.test(blob));
      if (hit) cands.push({ ...l, kind: hit.kind, rank: hit.rank });
    }
    if (!cands.length) return null;
    cands.sort((a, b) => a.rank - b.rank);

    // 依序嘗試前 3 個，取第一個能成功轉出文字的
    for (const c of cands.slice(0, 3)) {
      try {
        const buf = await downloadDoc(ctx, page, c.href, irUrl);
        if (!buf) continue;
        const txt = await pdfToText(buf);
        if (txt) return { kind: c.kind, url: c.href, title: c.text, text: txt, source: irUrl };
      } catch (e) { /* 換下一個候選 */ }
    }
    return null;
  } catch (e) {
    return null;
  } finally {
    try { await page.close(); } catch (e) {}
  }
}

// 逐字稿動輒 6～7 萬字，整份送 AI 會吃掉大量免費額度。
//   只擷取「展望／財測／資本支出／管理層對需求的看法」等段落。
//   ⚠️ 只節錄不改寫，原文一字不動——確保 AI 只能引用真實存在的內容。
const FOCUS_IR = [
  /outlook|guidance|expect|forecast|full[- ]year|next quarter/gi,
  /gross margin|operating margin|capital expenditure|capex/gi,
  /demand|growth|ramp|capacity|backlog/gi,
  /展望|財測|預估|預期|資本支出|毛利率|營業利益率|需求|成長/g,
  /we (?:believe|see|anticipate|plan|will)/gi
];
export function focusExcerptIr(text, maxLen = 14000) {
  const spans = [];
  for (const re of FOCUS_IR) {
    re.lastIndex = 0;
    let m, guard = 0;
    while ((m = re.exec(text)) && guard++ < 14) {
      spans.push([Math.max(0, m.index - 350), Math.min(text.length, m.index + 1100)]);
    }
  }
  if (!spans.length) return text.slice(0, maxLen);
  spans.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
    else merged.push([...s]);
  }
  let out = '';
  for (const [a, b] of merged) {
    if (out.length >= maxLen) break;
    out += (out ? '\n…\n' : '') + text.slice(a, Math.min(b, a + (maxLen - out.length)));
  }
  return out;
}
