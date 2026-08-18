// Vercel Serverless Function — 線上代理（取代本機 proxy.ps1）
// 讓網頁能讀 SEC EDGAR 與 Yahoo Finance 資料，並加上 CORS 標頭
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');

  const target = req.query.url;
  if (!target) {
    res.status(400).json({ error: 'missing url' });
    return;
  }
  // 只允許代理 SEC、Yahoo(含新聞feed、台股頁)、StockAnalysis(投資大行目標價)，避免被當成公開的萬用代理
  // tw.stock.yahoo.com：台股 ETF 前十大持股的來源(stockanalysis 的 /holdings/ 對台股一律404)
  if (!/^https:\/\/(data\.sec\.gov|www\.sec\.gov|query[12]\.finance\.yahoo\.com|feeds\.finance\.yahoo\.com|tw\.stock\.yahoo\.com|stockanalysis\.com)\//.test(target)) {
    res.status(403).json({ error: 'host not allowed' });
    return;
  }
  try {
    const r = await fetch(target, {
      headers: {
        // SEC 要求帶有聯絡資訊的 User-Agent
        'User-Agent': 'StockAnalyzer/1.0 (personal project; contact@example.com)',
        'Accept': 'application/json, text/html, */*'
      }
    });
    const body = await r.text();
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    // 即時報價(v8/finance/chart)快取1秒：使用者要求盤中「只要價格有變化就每秒即時跳動」。
    // 原本統一快取5分鐘，導致前端不管多頻繁輪詢，Vercel Edge在5分鐘內都回傳同一份舊資料，
    // 股價視覺上完全不動。s-maxage=1 讓邊緣快取最多只擋1秒，與前端每秒輪詢對齊。
    //
    // ⚠️ 報價「絕對不能」用 stale-while-revalidate：
    //   原本設 stale-while-revalidate=5，代表快取過期後邊緣仍會「先回舊價格」再背景更新。
    //   對股價而言回傳已知過期的數字＝直接顯示錯的價格(使用者2026-08-18回報：盤後開App
    //   先看到2405、再開一次2395、刷新才出現正確收盤價2400，就是不同邊緣節點各自回傳
    //   盤中殘留的舊快照)。價格寧可慢一點也不能錯，故移除 SWR，只保留1秒的請求合併。
    // 其餘(SEC/新聞/財務數據等不需要秒級更新的資料)維持原本5分鐘快取，降低重複請求。
    const isLiveQuote = /\/v8\/finance\/chart\//.test(target);
    res.setHeader('Cache-Control', isLiveQuote
      ? 'public, max-age=0, s-maxage=1'
      : 's-maxage=300, stale-while-revalidate=600');
    res.status(r.ok ? 200 : r.status).send(body);
  } catch (e) {
    res.status(502).json({ error: String(e && e.message || e) });
  }
}
