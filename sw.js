// ⚠️ Kill-switch Service Worker：專門用來「解除」先前卡死/造成重載迴圈的舊版 Service Worker。
// 一旦被瀏覽器抓到(sw.js 一律走網路、不受舊 SW 快取影響)，就會：清掉所有快取 → 自我註銷 → 讓頁面改用純網路最新版。
// 之後全站不再有 Service Worker 介入頁面，杜絕任何 SW/快取造成的重載迴圈或舊版殘留。
self.addEventListener('install', () => {
  self.skipWaiting();   // 立刻進入 activate，不等舊 SW 釋放
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    try {
      // 1) 清掉所有快取(含舊的 stock-app-shell-v1/v2/v3、stock-icons-v4 等)
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
      // 2) 接管目前所有頁面，才能把它們導回乾淨的網路版本
      await self.clients.claim();
      // 3) 自我註銷：解除這個 SW 對本網站的控制
      await self.registration.unregister();
      // 4) 讓所有開著的分頁重新載入一次(此時已無 SW、無快取 → 拿到純網路最新版，迴圈就此中止)
      const clients = await self.clients.matchAll({ type: 'window' });
      clients.forEach((c) => { try { c.navigate(c.url); } catch (err) {} });
    } catch (err) {}
  })());
});

// 刻意不註冊 fetch 事件：這個 SW 完全不攔截任何請求，頁面/資料一律走瀏覽器預設網路。
