// 從 SEC 8-K 取得公司自己發布的「財報新聞稿」全文
//
// 【為什麼要這個】
// XBRL companyfacts 只有結構化的財務「數字」，沒有兩樣最有價值的東西：
//   ① 官方對下一季的展望（guidance）—— 例如 NVIDIA「第三季營收預期 1,080 億美元 ±2%」
//   ② 分部／產品別營收 —— 例如 NVIDIA「Data Center 第二季 890 億美元，年增 117%」
// 這兩樣都寫在公司隨 8-K 申報的新聞稿裡（EX-99.1），SEC 免費公開、可直接抓。
//
// 【重要】這裡只負責「取得官方原文」。不做任何解讀、不補任何數字。
//   後續交給 AI 萃取時，也必須嚴格限定「只能引用原文出現過的內容」。

const UA = 'StockAnalyzer/1.0 (personal project; aa910517@gmail.com)';

async function getJson(url) {
  for (let i = 0; i < 3; i++) {
    try { const r = await fetch(url, { headers: { 'User-Agent': UA } }); if (r.ok) return await r.json(); if (r.status === 404) return null; }
    catch (e) {}
    await new Promise(r => setTimeout(r, 1200 * (i + 1)));
  }
  return null;
}
async function getText(url) {
  try { const r = await fetch(url, { headers: { 'User-Agent': UA } }); return r.ok ? await r.text() : null; }
  catch (e) { return null; }
}

// HTML → 純文字（新聞稿是排版用的表格式 HTML，直接去標籤即可）
export function htmlToText(html) {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;|&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// 新聞稿全文可達 14 萬字（實測台積電 Q2 合併報告），整份送給 AI 會吃掉大量免費額度、
//   也容易讓模型失焦。這裡只擷取「展望」與「分部營收」相關的段落及其前後文。
//   ⚠️ 只做「節錄」不做「改寫」——原文一字不改，確保後續 AI 只能引用真實存在的內容。
const FOCUS = [
  /outlook/gi, /guidance/gi, /we expect/gi, /expects? (?:revenue|to be|full)/gi,
  /for the (?:third|fourth|first|second) quarter/gi, /full[- ]year (?:20\d\d|fiscal)/gi,
  /segment/gi, /by (?:reportable )?segment/gi, /revenue by/gi,
  /data center|gaming|automotive|cloud|advertising|iphone|services revenue/gi
];
export function focusExcerpt(text, maxLen = 12000) {
  const spans = [];
  for (const re of FOCUS) {
    re.lastIndex = 0;
    let m, guard = 0;
    while ((m = re.exec(text)) && guard++ < 12) {
      spans.push([Math.max(0, m.index - 400), Math.min(text.length, m.index + 1200)]);
    }
  }
  if (!spans.length) return text.slice(0, maxLen);
  // 合併重疊區間，保持原文順序
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

// 找出最近一次「財報用」8-K（item 2.02 = Results of Operations），回傳新聞稿全文
export async function fetchLatestEarningsRelease(cik) {
  const pad = String(cik).padStart(10, '0');
  const sub = await getJson(`https://data.sec.gov/submissions/CIK${pad}.json`);
  const r = sub && sub.filings && sub.filings.recent;
  if (!r) return null;

  // ⚠️ 不能只看「最近 N 筆」：JPM 這類公司每天發大量 424B2（結構型商品公開說明書），
  //    實測 25,937 筆申報裡，財報 8-K 被擠到第 80 筆之外，只掃前 80 筆會完全找不到。
  //    改為掃描整個 recent 陣列（純陣列比對，成本極低），依日期由新到舊收集候選。
  const cands = [];
  for (let i = 0; i < r.form.length; i++) {
    const isEarnings8K = r.form[i] === '8-K' && /2\.02/.test(r.items[i] || '');
    const is6K = r.form[i] === '6-K';          // 外國發行人（台積電、ASML）用 6-K，沒有 items 欄位
    if (!isEarnings8K && !is6K) continue;
    // 太舊的不要：財報新聞稿超過半年就沒有「最新一季」的意義
    if ((Date.now() - new Date(r.filingDate[i])) / 86400000 > 200) continue;
    cands.push({ acc: r.accessionNumber[i], date: r.filingDate[i], form: r.form[i] });
    if (cands.length >= 12) break;
  }
  if (!cands.length) return null;

  // ⚠️ 6-K 不一定是季報：台積電每月都發「月營收」6-K（實測抓到只有 3,281 字的月報）。
  //    因此逐一檢查候選，取第一個「內容看起來真的是財報新聞稿」的。
  for (const hit of cands) {
    const dir = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${hit.acc.replace(/-/g, '')}`;
    const idx = await getJson(`${dir}/index.json`);
    const items = (idx && idx.directory && idx.directory.item) || [];

    // 挑出新聞稿檔案：排除 R*.htm（XBRL 檢視器片段）與 FilingSummary；
    //   優先檔名帶 press/release/earnings/narrative/results 等字樣，其次取最大檔
    //   （8-K 本體通常只有一兩頁，新聞稿才是大檔）
    const files = items
      .filter(x => /\.(htm|html|txt)$/i.test(x.name))
      .filter(x => !/^R\d+\.htm$/i.test(x.name) && !/FilingSummary|index-headers/i.test(x.name))
      .map(x => ({ name: x.name, size: Number(x.size) || 0 }))
      .filter(x => x.size >= 3000)
      .sort((a, b) => b.size - a.size);
    if (!files.length) continue;
    const preferred = files.find(x => /press|release|earnings|narrative|results|ex.?99/i.test(x.name));
    const pick = preferred || files[0];

    const html = await getText(`${dir}/${pick.name}`);
    if (!html) continue;
    const text = htmlToText(html);
    if (text.length < 1500) continue;
    // 內容驗證：必須同時出現營收與獲利相關字樣，才算真的是財報新聞稿
    //   （月營收公告、董事會決議之類的通知會被這一關擋掉）
    const looksLikeEarnings = /revenue|net sales|net revenue/i.test(text) &&
      /net income|net loss|earnings per share|operating income|diluted/i.test(text);
    if (!looksLikeEarnings) continue;

    return { text, file: pick.name, filedAt: hit.date, form: hit.form, url: `${dir}/${pick.name}` };
  }
  return null;
}
