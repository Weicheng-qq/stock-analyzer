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
  // 只允許代理 SEC 與 Yahoo，避免被當成公開的萬用代理
  if (!/^https:\/\/(data\.sec\.gov|www\.sec\.gov|query[12]\.finance\.yahoo\.com)\//.test(target)) {
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
    // 快取 5 分鐘，降低重複請求
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    res.status(r.ok ? 200 : r.status).send(body);
  } catch (e) {
    res.status(502).json({ error: String(e && e.message || e) });
  }
}
