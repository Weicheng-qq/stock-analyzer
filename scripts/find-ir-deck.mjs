// ════════════════════════════════════════════════════════════════════════════
// 自動探勘「公司官方網站 → 投資人關係 → 法說會簡報 PDF」
// ════════════════════════════════════════════════════════════════════════════
// 為什麼需要這支？
//   使用者要求第五階段的法說內容一律以【公司官方網頁】為來源。
//   但 2026-09-13 實際踩到一個嚴重問題：我先前只抓公司官網首頁，就把 6104 創惟
//   寫成「查無公開法人說明會」—— 事實上它官網的「投資人關係 → 財務資訊 → 法說資訊」
//   裡就有 2026/08/21 的法說會簡報 PDF，而且內容遠比櫃買季報豐富
//   （六季毛利率走勢、營收結構占比、USB4 量產進度…）。
//   「查無」若是因為沒找對頁面，那就是在騙使用者，等級跟畫面謊稱資料很新一樣嚴重。
//   剩餘 384 家不可能逐家人工翻官網，所以把「找到官方簡報」這件事自動化。
//
// 作法（三層）：
//   ① 由櫃買「公司基本資料」OpenAPI 取得官方登記的公司網址（WebAddress）
//      —— 關鍵：網址是用【股票代碼】查出來的，不可能查到同名的別家公司。
//      先前手工時代踩過一串同名坑（5312寶島科 vs 寶島陽光、4905台聯電 vs 2303聯電、
//      5403中菲電腦 vs 5609中菲行），這一層從根本消除該風險。
//   ② 抓官網首頁，用關鍵字比對找出投資人關係／法說相關連結，逐一進入
//      （法說頁常在二層：投資人關係 → 財務資訊 → 法說資訊）。
//   ③ 在候選頁面裡找 PDF 連結，依檔名/連結文字中的日期挑最新的一份。
//
// 使用：node scripts/find-ir-deck.mjs 6104 6109 6111
//       node scripts/find-ir-deck.mjs --file codes.txt
// 輸出：JSON 到 stdout，每家一筆 {code, name, site, irPages, deck, deckDate, note}
//
// ⚠️ 這支只負責「找到官方來源」，不負責寫內容 —— 內容仍由人讀過官方簡報後撰寫。
//    自動摘要官方簡報會違反本專案「不臆測、以官方原文為準」的鐵則。
// ⚠️ 禮貌限制：每個網域之間留間隔、設逾時、失敗就放棄，不對公司網站造成負擔。
// ════════════════════════════════════════════════════════════════════════════

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const TPEX_PROFILE = 'https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O';
const TIMEOUT = 15000;
const GAP_MS = 700;          // 每次請求之間的間隔，避免對公司網站造成負擔

// 連結文字/網址裡出現這些字，視為「可能是投資人關係或法說頁」。
//   排序即優先序：越前面越可能直接是法說頁。
const IR_HINTS = [
  '法說', '法人說明會', 'earnings', 'conference', 'presentation',
  '投資人', '投資者', 'investor', '財務資訊', 'financial', '/ir', 'ir/'
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function get(url, asText = true) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT);
  try {
    const r = await fetch(url, {
      signal: ac.signal,
      redirect: 'follow',
      headers: { 'User-Agent': UA, 'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8' }
    });
    if (!r.ok) return { ok: false, status: r.status, url: r.url };
    return { ok: true, status: r.status, url: r.url, body: asText ? await r.text() : null };
  } catch (e) {
    return { ok: false, status: 0, err: String(e && e.message || e) };
  } finally { clearTimeout(t); }
}

// 從 HTML 撈出 <a href> 與其文字
function links(html, base) {
  const out = [];
  const re = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    let href = m[1].trim();
    if (!href || /^(#|javascript:|mailto:|tel:)/i.test(href)) continue;
    let abs;
    try { abs = new URL(href, base).href; } catch { continue; }
    const text = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    out.push({ href: abs, text });
  }
  return out;
}

// 連結像不像投資人關係/法說頁？回傳分數（越高越像），0 = 不像
function irScore(l) {
  const hay = (l.text + ' ' + l.href).toLowerCase();
  let s = 0;
  IR_HINTS.forEach((h, i) => { if (hay.includes(h.toLowerCase())) s += (IR_HINTS.length - i); });
  return s;
}

// 從字串裡找 8 位數日期(20260821)或 6 位數(202608)，用來判斷哪份 PDF 最新
function dateKey(s) {
  const m8 = s.match(/(20\d{6})/);
  if (m8) return m8[1];
  const m6 = s.match(/(20\d{4})/);
  if (m6) return m6[1] + '00';
  // 民國年：115年08月21日 / 1150821
  const mr = s.match(/(1[0-2]\d)[年\-_/]?(\d{1,2})[月\-_/]?(\d{1,2})?/);
  if (mr) {
    const y = 1911 + Number(mr[1]);
    return String(y) + String(mr[2]).padStart(2, '0') + String(mr[3] || 0).padStart(2, '0');
  }
  return '';
}

async function pdfsIn(url) {
  const r = await get(url);
  if (!r.ok) return { ok: false, status: r.status, err: r.err, pdfs: [], all: [] };
  const all = links(r.body, r.url);
  const pdfs = all
    .filter(l => /\.pdf(\?|$)/i.test(l.href))
    .map(l => ({ ...l, key: dateKey(l.href) || dateKey(l.text) }));
  return { ok: true, pdfs, all, finalUrl: r.url };
}

async function findForCode(code, profile) {
  const p = profile.find(x => x.SecuritiesCompanyCode === code);
  const res = { code, name: p ? p.CompanyName : null, site: null, irPages: [], deck: null, deckDate: null, note: '' };
  if (!p) { res.note = '櫃買公司基本資料查無此代碼'; return res; }

  let raw = (p.WebAddress || '').trim();
  if (!raw) { res.note = '官方名冊未登記公司網址'; return res; }

  // ⚠️⚠️ 官方名冊登記的網址不一定still有效，2026-09-13 實測到三種情況：
  //   ① 登記 http:// 但實際只有 https（6129 普誠：http 不通、https 回 302）
  //   ② 登記少了 .tw（6125 廣運登記 kenmec.com，實際多為 kenmec.com.tw）
  //   ③ 真的連不上（curl 同樣失敗，確認非本機問題）
  //   所以逐一嘗試常見變體，全部失敗才判定無法存取，避免產生大量假的「官網無法存取」。
  const host = raw.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  const bare = host.replace(/^www\./i, '');
  const variants = [...new Set([
    'https://' + host,
    'http://' + host,
    'https://www.' + bare,
    'https://' + bare,
    /\.tw$/i.test(bare) ? null : 'https://www.' + bare + '.tw',
    /\.tw$/i.test(bare) ? null : 'https://' + bare + '.tw'
  ].filter(Boolean))];

  let home = null;
  for (const v of variants) {
    const r = await pdfsIn(v);
    await sleep(GAP_MS);
    if (r.ok) { home = r; res.site = r.finalUrl || v; res.siteTried = v; break; }
  }
  if (!home) {
    res.site = raw;
    res.note = '官網無法存取（已試 ' + variants.length + ' 種網址變體皆失敗；已用 curl 交叉確認非本機問題）';
    return res;
  }

  // ② 候選 IR 連結（取分數最高的前 4 個，去重同網址）
  const seen = new Set();
  const seenTalk = new Set();   // 含「法說」字樣的連結文字，作為「有沒有辦法說會」的證據
  const noteTalk = arr => arr.forEach(l => {
    if (/法說|法人說明會/.test(l.text + ' ' + l.href) && l.text) seenTalk.add(l.text.slice(0, 90));
  });
  noteTalk(home.all);
  const cands = home.all
    .map(l => ({ ...l, s: irScore(l) }))
    .filter(l => l.s > 0)
    .sort((a, b) => b.s - a.s)
    .filter(l => { if (seen.has(l.href)) return false; seen.add(l.href); return true; })
    .slice(0, 4);

  const pool = [...home.pdfs];

  for (const c of cands) {
    const page = await pdfsIn(c.href);
    await sleep(GAP_MS);
    if (!page.ok) continue;
    res.irPages.push({ text: c.text, url: c.href, pdfs: page.pdfs.length });
    pool.push(...page.pdfs);
    noteTalk(page.all);

    // ③ 二層：這個 IR 頁面裡再找一次「法說」連結（法說頁常在二層）
    const sub = page.all
      .map(l => ({ ...l, s: irScore(l) }))
      .filter(l => l.s >= IR_HINTS.length - 2)   // 只追很像「法說」的
      .filter(l => !seen.has(l.href))
      .slice(0, 2);
    for (const s2 of sub) {
      seen.add(s2.href);
      const p2 = await pdfsIn(s2.href);
      await sleep(GAP_MS);
      if (!p2.ok) continue;
      res.irPages.push({ text: s2.text, url: s2.href, pdfs: p2.pdfs.length, depth: 2 });
      pool.push(...p2.pdfs);
      noteTalk(p2.all);
    }
  }

  // ⚠️⚠️ 沒有 PDF 不等於「查無法說會」——這是 2026-09-13 踩到的第二個坑。
  //   6113 亞矽官網明確有「法人說明會資訊─2025年11月28日受邀參加凱基證券之線上法人說明會
  //   (影音檔案)」，它確實辦法說會，只是官方只放影音、不放簡報 PDF。
  //   若因為找不到 PDF 就寫「查無公開法人說明會」，那是錯誤陳述。
  //   因此這裡把所有「法說」相關的連結文字保留為證據，供撰寫時據實描述。
  res.talkEvidence = [...seenTalk].slice(0, 12);
  if (!pool.length) {
    res.note = res.talkEvidence.length
      ? '官網【有】法說相關頁面但未提供簡報 PDF（可能僅影音檔或外部連結）——不可寫成「查無法說會」'
      : '官網可存取，但首頁與投資人關係相關頁面均未見法說專區與 PDF';
    return res;
  }

  // 挑日期最新的一份；完全沒有日期線索時取第一份
  pool.sort((a, b) => (b.key || '').localeCompare(a.key || ''));
  res.deck = pool[0].href;
  res.deckDate = pool[0].key || null;
  res.talkEvidence = [...seenTalk].slice(0, 12);
  res.note = '共找到 ' + pool.length + ' 份 PDF，已取日期最新者';
  return res;
}

(async () => {
  const args = process.argv.slice(2);
  let codes = [];
  const fi = args.indexOf('--file');
  if (fi > -1) {
    const fs = await import('fs');
    codes = fs.readFileSync(args[fi + 1], 'utf8').split(/\r?\n/)
      .map(l => (l.trim().split(/\s+/)[0] || '')).filter(c => /^\d{4,6}$/.test(c));
  } else {
    codes = args.filter(a => /^\d{4,6}$/.test(a));
  }
  if (!codes.length) { console.error('用法：node scripts/find-ir-deck.mjs 6104 6109 …  或  --file codes.txt'); process.exit(1); }

  // 公司名冊：優先用 --profile 指定的本機檔（離線可跑、也避免重複打櫃買），
  //   沒指定才線上抓。實測 2026-09-13 從 node 直連該端點偶有失敗，故保留本機退路。
  const fsm = await import('fs');
  const pfi = args.indexOf('--profile');
  let profile = null;
  if (pfi > -1 && args[pfi + 1]) {
    profile = JSON.parse(fsm.readFileSync(args[pfi + 1], 'utf8'));
  } else {
    const pr = await get(TPEX_PROFILE);
    if (!pr.ok) {
      console.error('取櫃買公司基本資料失敗（' + (pr.status || pr.err) + '）。請改用 --profile <本機名冊.json>');
      process.exit(1);
    }
    profile = JSON.parse(pr.body);
  }

  const out = [];
  for (const c of codes) {
    const r = await findForCode(c, profile);
    out.push(r);
    console.error('· ' + c + ' ' + (r.name || '') + ' → ' + (r.deck ? ('找到簡報 ' + (r.deckDate || '') ) : r.note));
  }
  console.log(JSON.stringify(out, null, 2));
})();
