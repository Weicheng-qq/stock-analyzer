// 從公開資訊觀測站（MOPS）取得台股「法人說明會簡報」內容
//
// 【為什麼要這個】
// TWSE 的 OpenAPI 只有結構化的財務「數字」，沒有公司對未來的展望與產品別說明。
// 台股這些內容在公司上傳到 MOPS 的法說會簡報 PDF 裡——這是台股版的「財報新聞稿」。
// 實測台泥簡報可取得：營收 NT$38.1B、毛利率 17.8%、營業利益率 6.2%、EPS NT$0.29、各項年增幅。
//
// 【資料路徑（全部免費公開，已實測）】
//   一覽表：POST https://mopsov.twse.com.tw/mops/web/ajax_t100sb02_1
//           參數 TYPEK=sii(上市)/otc(上櫃)、year=民國年、month=月
//           回應是 UTF-8 的 HTML 表格，欄位含：代號/名稱/日期/時間/地點/摘要/中文PDF/英文PDF
//   簡報檔：https://mopsov.twse.com.tw/nas/STR/{檔名}.pdf
//           檔名格式如 110120260829M002.pdf（M=中文版、E=英文版）
//
// 【相依】pdftotext（poppler-utils）。GitHub Actions 需先 apt-get install poppler-utils。
//   若環境沒有這個指令，本模組會回傳 null 而不中斷整個流程。
//
// ⚠️ 台股小型公司很多根本不開法說會，取得率本來就會比美股低，屬正常現象。

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const execFileP = promisify(execFile);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const BASE = 'https://mopsov.twse.com.tw';

// 西元年月 → 民國年月
const toRoc = d => ({ year: d.getFullYear() - 1911, month: String(d.getMonth() + 1).padStart(2, '0') });

async function postForm(url, body) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
        body
      });
      if (r.ok) return await r.text();
    } catch (e) {}
    await new Promise(r => setTimeout(r, 1500 * (i + 1)));
  }
  return null;
}

// 解析一覽表 HTML 表格
function parseTable(html) {
  const out = [];
  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
  for (const m of rows) {
    const cells = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
      .map(c => c[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim());
    if (cells.length < 7) continue;
    const [code, name, date, time, place, summary, pdfZh, pdfEn] = cells;
    if (!/^\d{4}$/.test(code)) continue;
    // 中文版優先；沒有中文版才用英文版
    const pdf = /\.pdf$/i.test(pdfZh || '') ? pdfZh : (/\.pdf$/i.test(pdfEn || '') ? pdfEn : null);
    out.push({ code, name, date, time, place, summary, pdf });
  }
  return out;
}

// 取最近 N 個月的法說會一覽（上市 + 上櫃）
// 回傳 Map: 公司代號 → 最新一場法說會資訊
export async function fetchCallIndex(monthsBack = 4) {
  const map = new Map();
  const now = new Date();
  for (let b = 0; b < monthsBack; b++) {
    const d = new Date(now.getFullYear(), now.getMonth() - b, 1);
    const { year, month } = toRoc(d);
    for (const typek of ['sii', 'otc']) {
      const html = await postForm(`${BASE}/mops/web/ajax_t100sb02_1`,
        `encodeURIComponent=1&step=1&firstin=1&off=1&TYPEK=${typek}&year=${year}&month=${month}`);
      if (!html) continue;
      for (const row of parseTable(html)) {
        if (!row.pdf) continue;
        // 同一家公司留最新一場（外層迴圈由新到舊，先寫入者較新）
        if (!map.has(row.code)) map.set(row.code, { ...row, market: typek });
      }
      await new Promise(r => setTimeout(r, 600));   // 不對 MOPS 造成高頻請求
    }
  }
  return map;
}

// Linux/GitHub Actions 上 apt 裝好就在 PATH；Windows 本機開發時 Git Bash 的 /mingw64/bin
//   不在 Node 的 PATH 裡，可用 PDFTOTEXT_BIN 指定完整路徑（例如
//   PDFTOTEXT_BIN="C:\Program Files\Git\mingw64\bin\pdftotext.exe"）。
const PDFTOTEXT = process.env.PDFTOTEXT_BIN || 'pdftotext';
let pdftotextOk = null;
async function hasPdftotext() {
  if (pdftotextOk !== null) return pdftotextOk;
  // ⚠️ `pdftotext -v` 會把版本印到 stderr 並回傳「非零」結束碼，所以不能用「有沒有拋錯」
  //    判斷存在與否（我原本這樣寫，導致明明裝好了卻一律判定成找不到）。
  //    正確作法：看錯誤訊息裡有沒有版本字樣，或錯誤是不是 ENOENT（真的找不到執行檔）。
  try { await execFileP(PDFTOTEXT, ['-v']); pdftotextOk = true; }
  catch (e) {
    const blob = `${e.stderr || ''}${e.stdout || ''}${e.message || ''}`;
    pdftotextOk = /pdftotext|poppler/i.test(blob) && e.code !== 'ENOENT';
    if (!pdftotextOk) console.warn('⚠️ 找不到 pdftotext，台股法說會簡報將略過（需安裝 poppler-utils）');
  }
  return pdftotextOk;
}

// 下載簡報 PDF 並轉成純文字
export async function fetchCallPdfText(pdfName) {
  if (!pdfName || !await hasPdftotext()) return null;
  // 檔名只允許英數與點，擋掉路徑穿越
  if (!/^[A-Za-z0-9._-]{6,80}$/.test(pdfName)) return null;
  let tmpPdf = '', tmpTxt = '';
  try {
    const r = await fetch(`${BASE}/nas/STR/${pdfName}`, {
      headers: { 'User-Agent': UA, 'Referer': `${BASE}/mops/web/t100sb02_1` }
    });
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 5000 || buf.subarray(0, 4).toString() !== '%PDF') return null;
    tmpPdf = path.join(os.tmpdir(), `mops_${Date.now()}_${Math.random().toString(36).slice(2)}.pdf`);
    tmpTxt = tmpPdf.replace(/\.pdf$/, '.txt');
    fs.writeFileSync(tmpPdf, buf);
    await execFileP(PDFTOTEXT, ['-enc', 'UTF-8', tmpPdf, tmpTxt], { timeout: 60000 });
    const text = fs.readFileSync(tmpTxt, 'utf8').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    return text.length > 300 ? text : null;
  } catch (e) {
    return null;
  } finally {
    for (const f of [tmpPdf, tmpTxt]) { try { if (f) fs.unlinkSync(f); } catch (e) {} }
  }
}

// 法說會簡報動輒數十頁，整份送 AI 會吃掉大量免費額度。
//   只擷取展望／財測／營收結構相關段落及前後文。⚠️ 只節錄不改寫，原文一字不動。
const FOCUS_TW = [
  /展望/g, /財測/g, /指引/g, /預估/g, /預期/g, /目標/g, /規劃/g, /下半年/g, /全年/g,
  /營收/g, /毛利率/g, /營業利益/g, /每股盈餘|EPS/g,
  /產品組合|營收占比|營收比重|產品別|事業群|業務別/g, /資本支出|CAPEX/gi
];
export function focusExcerptTw(text, maxLen = 9000) {
  const spans = [];
  for (const re of FOCUS_TW) {
    re.lastIndex = 0;
    let m, guard = 0;
    while ((m = re.exec(text)) && guard++ < 10) {
      spans.push([Math.max(0, m.index - 250), Math.min(text.length, m.index + 800)]);
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
