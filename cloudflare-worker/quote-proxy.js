// ════════════════════════════════════════════════════════════════════════════
// 報價代理 — Cloudflare Worker 版（選填，免費）
// ════════════════════════════════════════════════════════════════════════════
// 為什麼需要這支？
//   證交所盤中資訊系統(mis.twse.com.tw)與 Yahoo Finance 都「不送 CORS 標頭」，
//   瀏覽器沒辦法直接打，一定要有一台伺服器代轉。本專案原本用 Vercel 的
//   /api/proxy，但 Vercel Hobby 免費額度只有每月 100 萬次 Function 呼叫，
//   而且明文「僅限非商業個人用途」、超過不能加購只能等 30 天。
//   Cloudflare Workers 免費方案是每天 10 萬次請求（約每月 300 萬次）、
//   允許商業用途，所以把「報價」這條最吃量的路單獨搬過來。
//
// 這支 Worker 與 api/proxy.js 的行為刻意保持一致：
//   ① 同一份白名單（只轉報價來源，不做公開萬用代理）
//   ② 同樣的 5 秒邊緣快取（與前端 refreshLivePrices 的 gap 對齊）
//   ③ 同樣的錯誤格式 {error:"..."}，前端不需要為它寫另一套處理
//
// 部署方式見同資料夾的 README.md。設定完成後，在 App 的 ⚙️ 設定 →
//   「進階：自建報價代理」貼上 Worker 網址即可；留空就是繼續用 /api/proxy。
// ════════════════════════════════════════════════════════════════════════════

// 只允許這些來源。⚠️ 要與 api/proxy.js 的白名單一起維護，改一邊會造成兩邊行為不一致。
const ALLOW = /^https:\/\/(mis\.twse\.com\.tw|query[12]\.finance\.yahoo\.com)\//;

export default {
  async fetch(request) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
    };

    // 瀏覽器的預檢請求
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const target = new URL(request.url).searchParams.get('url');
    if (!target) {
      return json({ error: 'missing url' }, 400, cors);
    }
    if (!ALLOW.test(target)) {
      return json({ error: 'host not allowed' }, 403, cors);
    }

    try {
      // cf.cacheTtl：讓 Cloudflare 自己在邊緣快取 5 秒。
      //   多個使用者同時看同一支股票時，只有第一個會真的打到證交所，
      //   其餘直接吃邊緣快取 —— 打到對方伺服器的次數與使用者人數脫鉤。
      const upstream = await fetch(target, {
        headers: {
          'User-Agent': 'StockAnalyzer/1.0 (personal project)',
          'Accept': 'application/json, text/html, */*',
        },
        cf: { cacheTtl: 5, cacheEverything: true },
      });
      const body = await upstream.text();
      return new Response(body, {
        status: upstream.ok ? 200 : upstream.status,
        headers: {
          ...cors,
          'Content-Type': 'application/json; charset=utf-8',
          // 與 api/proxy.js 完全相同的快取策略：
          //   刻意不加 stale-while-revalidate，報價寧可慢一拍抓新的，也不要回舊值。
          'Cache-Control': 'public, max-age=0, s-maxage=5',
        },
      });
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 502, cors);
    }
  },
};

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' },
  });
}
