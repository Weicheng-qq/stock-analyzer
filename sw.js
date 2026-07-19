// ⚠️ Kill-switch Service Worker：解除先前造成重載迴圈的舊版 SW。
// 只做兩件事：清掉所有快取 + 自我註銷(unregister)。順序為「先清快取、再註銷」，確保釋放控制權時已無舊 HTML 可服務。
// 【關鍵】絕對不呼叫 clients.claim() 或 c.navigate()/reload —— 任何由 SW 主動觸發的頁面導向都會與舊頁面的重新註冊形成重載迴圈。
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k))); // 1) 先清掉所有快取(含舊 HTML)
      await self.registration.unregister();                 // 2) 再自我註銷
    } catch (err) {}
  })());
});

// 不註冊 fetch 事件：完全不攔截任何請求，也不強制重新載入任何頁面。
