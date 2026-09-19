// Cloudflare Pages Function — 線上代理（對應 Vercel 的 api/proxy.js）
//
// 【搬遷理由】Vercel Hobby 方案「僅限非商業用途」，明文包含「放置廣告」與「向使用者收費」。
//   只要將來要靠 AdMob 或訂閱獲利，整個 App 就必須離開 Hobby（Pro 為 US$20/月）。
//   Cloudflare Pages 免費方案允許商業用途，且報價代理（cloudflare-worker/quote-proxy.js）
//   早已在 Cloudflare 上跑得很穩，等於這條路已經驗證過。
//
// 【與 Vercel 版的差異】
//   Vercel：export default handler(req, res)，用 res.setHeader / res.status().send()
//   Pages ：export function onRequest(context)，回傳標準的 Response 物件
//   兩者的邊緣快取都吃 Cache-Control 的 s-maxage，所以快取策略可以原樣照搬。
//
// ⚠️ 允許清單必須與 Vercel 版、以及 cloudflare-worker/quote-proxy.js 保持一致。
//   三個地方各有一份是歷史包袱；改其中一個就要三個一起改，否則會出現
//   「某個資料來源在某條路徑上能過、另一條過不了」的難查問題。
const ALLOW = /^https:\/\/(data\.sec\.gov|www\.sec\.gov|query[12]\.finance\.yahoo\.com|feeds\.finance\.yahoo\.com|tw\.stock\.yahoo\.com|stockanalysis\.com|mis\.twse\.com\.tw)\//;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*'
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' }
  });
}

export async function onRequest(context) {
  const { request } = context;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const target = new URL(request.url).searchParams.get('url');
  if (!target) return json({ error: 'missing url' }, 400);
  if (!ALLOW.test(target)) return json({ error: 'host not allowed' }, 403);

  // 報價與其他資料的快取秒數不同，要在發請求前就決定好。
  const isLiveQuote = /\/v8\/finance\/chart\//.test(target) || /mis\.twse\.com\.tw\/stock\/api\//.test(target);

  try {
    const r = await fetch(target, {
      headers: {
        // SEC 要求帶有聯絡資訊的 User-Agent
        'User-Agent': 'StockAnalyzer/1.0 (personal project; contact@example.com)',
        'Accept': 'application/json, text/html, */*'
      },
      // Cloudflare 自己的邊緣快取（真正讓多個使用者共用同一份上游回應的是這一層）。
      // ⚠️ 2026-09-19 改為：報價 1 秒（前端改每秒輪詢）、其他資料 300 秒。
      //   原本一律 5 秒，連 SEC 財報這種一天才變一次的資料也每 5 秒就回源一次。
      cf: { cacheTtl: isLiveQuote ? 1 : 300, cacheEverything: true }
    });
    const body = await r.text();

    // ⚠️ 即時報價走 5 秒邊緣快取，其餘走 5 分鐘。這個 5 秒必須與前端
    //   refreshLivePrices() 的 gap(5000) 一致，只改單邊沒有意義：
    //   前端比快取快，多打的那幾次只會拿到同一份快取；前端比快取慢，快取就白設。
    //   ⚠️ 刻意不對報價加 stale-while-revalidate：寧可稍慢一拍去抓新的，也不要回舊值，
    //      否則會重演「看起來很新、其實是舊價」那個讓使用者困擾很多次的症狀。
    return new Response(body, {
      status: r.ok ? 200 : r.status,
      headers: {
        ...CORS,
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': isLiveQuote
          ? 'public, max-age=0, s-maxage=1'
          : 's-maxage=300, stale-while-revalidate=600'
      }
    });
  } catch (e) {
    return json({ error: String((e && e.message) || e) }, 502);
  }
}
