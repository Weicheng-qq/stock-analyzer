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
  // 只允許代理 SEC、Yahoo(含新聞feed、台股頁)、StockAnalysis(投資大行目標價)、TWSE即時報價，避免被當成公開的萬用代理
  // tw.stock.yahoo.com：台股 ETF 前十大持股的來源(stockanalysis 的 /holdings/ 對台股一律404)
  // mis.twse.com.tw：證交所官方即時盤中資訊系統(供一般網頁看盤小工具使用)，免費、無需金鑰，
  //   實測比Yahoo Finance的台股報價新鮮很多(Yahoo對.TW常有十幾分鐘延遲，開盤時常顯示不動/錯誤的舊價，
  //   使用者2026-08-26回報)。改用此源可讓台股即時價更貼近實際成交，仍完全免費符合零費用原則。
  if (!/^https:\/\/(data\.sec\.gov|www\.sec\.gov|query[12]\.finance\.yahoo\.com|feeds\.finance\.yahoo\.com|tw\.stock\.yahoo\.com|stockanalysis\.com|mis\.twse\.com\.tw)\//.test(target)) {
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
    // 即時報價完全不快取(no-store)：使用者連續三次回報開盤股價「不動、且顯示昨收」，
    //   即使已改用TWSE官方即時來源+4秒逾時仍未解決，故不再信任任何形式的邊緣/共享快取，
    //   改為徹底停用快取，讓每一次前端輪詢都真正打到TWSE/Yahoo原始伺服器，排除快取層
    //   本身是問題根源的可能性(即使s-maxage=1理論上只擋1秒，仍無法排除CDN在高流量下
    //   實際行為與HTTP語意不完全一致的風險)。個人專案流量低，不快取的額外負擔可忽略。
    //   其餘(SEC/新聞/財務數據等不需要秒級更新的資料)維持原本5分鐘快取，降低重複請求。
    const isLiveQuote = /\/v8\/finance\/chart\//.test(target) || /mis\.twse\.com\.tw\/stock\/api\//.test(target);
    res.setHeader('Cache-Control', isLiveQuote
      ? 'no-store'
      : 's-maxage=300, stale-while-revalidate=600');
    res.status(r.ok ? 200 : r.status).send(body);
  } catch (e) {
    res.status(502).json({ error: String(e && e.message || e) });
  }
}
