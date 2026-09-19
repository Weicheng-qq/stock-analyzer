// Cloudflare Pages Function — 「今天有人查看了哪些股票」的匿名統計
//
// 【為什麼需要】
//   每日排程一天最多分析 40 家。使用者要求：大家實際點過的公司要排在五階段名單前面
//   （2026-09-19：「如果每天的使用者去點的不到 40 間，則依照我的五階段公司去更新」）。
//   排程要知道「大家點了哪些」，就需要一個地方記下來。
//
// 【只記股票代碼，不記任何人】
//   存的內容只有「日期＋股票代碼」，例如 d:20260919:2330。
//   沒有 IP、沒有裝置資訊、沒有 Cookie、沒有次數以外的任何東西，7 天後自動刪除。
//   隱私權政策第 3 節有相應說明。
//
// 【需要一次性設定】Cloudflare KV（免費方案：每天 10 萬次讀取、1,000 次寫入）
//   Cloudflare → Storage & databases → KV → 建立 namespace（名稱隨意，例如 stock-demand）
//   → Workers & Pages → weicheng-stock → Settings → Bindings → Add → KV namespace
//   → Variable name 填 DEMAND、選剛建的 namespace → 重新部署。
//   沒設定時這支回 501，前端與排程都會安靜略過，排程就只依五階段排序，不會壞。
//
//   POST /api/demand   body {"symbol":"2330"}   記錄今天有人查看
//   GET  /api/demand?days=3                     回傳最近幾天被查看過的代碼（給每日排程用）

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' };
const json = (obj, status, extra) => new Response(JSON.stringify(obj), {
  status: status || 200,
  headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', ...(extra || {}) }
});

// 台北時間的日期（台股、美股使用者主要都在台灣）
const ymd = d => new Date(d).toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' }).replace(/-/g, '');
// 只接受像股票代碼的字串，擋掉亂塞的內容（台股 4～6 碼數字、美股 1～6 個英文字母可含 . -）
const SYMBOL = /^(\d{4,6}[A-Z]?|[A-Z]{1,6}([.-][A-Z]{1,2})?)$/;

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const kv = env.DEMAND;
  if (!kv) return json({ ok: false, error: 'KV（DEMAND）尚未設定，略過' }, 501);

  if (request.method === 'POST') {
    let body; try { body = await request.json(); } catch (e) { body = null; }
    const symbol = String((body && body.symbol) || '').trim().toUpperCase();
    if (!SYMBOL.test(symbol)) return json({ ok: false, error: 'bad symbol' }, 400);
    const key = 'd:' + ymd(Date.now()) + ':' + symbol;
    // 同一天同一檔只寫一次：免費方案每天只有 1,000 次寫入，讀取則有 10 萬次，先讀再寫最省。
    try {
      if (await kv.get(key) === null) await kv.put(key, '1', { expirationTtl: 7 * 86400 });
    } catch (e) { return json({ ok: false, error: 'KV 寫入失敗（可能是今日免費額度用完）' }, 503); }
    return json({ ok: true });
  }

  if (request.method === 'GET') {
    const days = Math.min(7, Math.max(1, parseInt(new URL(request.url).searchParams.get('days') || '3', 10) || 3));
    const out = [];   // 新的日期在前，同一天內依 KV 回傳順序
    try {
      for (let i = 0; i < days; i++) {
        const prefix = 'd:' + ymd(Date.now() - i * 86400000) + ':';
        let cursor;
        do {
          const r = await kv.list({ prefix, cursor, limit: 1000 });
          r.keys.forEach(k => out.push(k.name.slice(prefix.length)));
          cursor = r.list_complete ? null : r.cursor;
        } while (cursor);
      }
    } catch (e) { return json({ ok: false, error: 'KV 讀取失敗' }, 503); }
    const symbols = [...new Set(out)];
    // 快取 10 分鐘：這支只有每日排程會讀，快取可以避免被人狂刷而用光每日 list 額度
    return json({ ok: true, days, count: symbols.length, symbols }, 200, { 'Cache-Control': 'public, max-age=600' });
  }

  return json({ ok: false, error: 'GET or POST only' }, 405);
}
