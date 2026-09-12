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
    // ⚠️⚠️ 2026-09-12：即時報價由 no-store 改回「邊緣快取 5 秒」。
    //   當初改成 no-store，是因為使用者連續四次回報開盤股價「不動、且顯示昨收」，
    //   在還沒找到真因時把快取當成嫌疑犯先排除掉。但 2026-08-31 已經確認真因是
    //   前端程式的 bug —— TWSE 的 z(最新成交價) 回 "-" 時，程式直接拿 y(昨收) 冒充現價
    //   (見 stock_analyzer.html 的 fetchTwMisQuotes 註解)。快取並不是兇手，那個 bug 已修好。
    //   改回快取的理由是成本：TWSE 不給 CORS，前端每一次報價輪詢都必須經過這支函式，
    //   等於一次 Vercel Function 呼叫，而 Hobby 免費額度只有每月 100 萬次、超過不能加購
    //   只能等 30 天(屆時全部使用者的股價會一起掛掉)。s-maxage=5 讓所有使用者共用同一份
    //   5 秒快取 —— 1000 個人看台積電，打到 TWSE 的次數與 1 個人幾乎一樣，與人數脫鉤。
    //   同時也避免大量請求從 Vercel 的 IP 打到證交所而被對方封鎖。
    //   ⚠️ 這個 5 秒必須與前端 refreshLivePrices() 的 gap(5000) 一致，只改單邊沒有意義：
    //      前端若比快取快，多打的那幾次只會拿到同一份快取；前端若比快取慢，快取就白設。
    //   ⚠️ 刻意不加 stale-while-revalidate：報價寧可稍慢一拍去抓新的，也不要回舊值，
    //      否則就會重演「看起來很新、其實是舊價」那個讓使用者困擾四次的症狀。
    //   其餘(SEC/新聞/財務數據等不需要秒級更新的資料)維持原本5分鐘快取，降低重複請求。
    const isLiveQuote = /\/v8\/finance\/chart\//.test(target) || /mis\.twse\.com\.tw\/stock\/api\//.test(target);
    res.setHeader('Cache-Control', isLiveQuote
      ? 'public, max-age=0, s-maxage=5'
      : 's-maxage=300, stale-while-revalidate=600');
    res.status(r.ok ? 200 : r.status).send(body);
  } catch (e) {
    res.status(502).json({ error: String(e && e.message || e) });
  }
}
