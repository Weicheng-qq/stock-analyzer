// ⚠️ Kill-switch Service Worker：解除先前造成重載迴圈的舊版 SW。
// 只做兩件事：自我註銷(unregister) + 清掉所有快取。
// 【關鍵】絕對不呼叫 clients.claim() 或 c.navigate()/reload —— 任何由 SW 主動觸發的頁面導向都可能與舊頁面的重新註冊形成重載迴圈。
// 清乾淨後，使用者下次自行載入頁面時，因為已無 SW、無快取，會直接拿到純網路最新版，迴圈自然中止。
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    try {
      await self.registration.unregister();               // 先註銷自己
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k))); // 再清掉所有快取
    } catch (err) {}
  })());
});

// 不註冊 fetch 事件：完全不攔截任何請求，也不強制重新載入任何頁面。
