// Service Worker（極簡版）：只快取圖示以支援「安裝到主畫面」，完全不介入 HTML/資料請求。
// 重要：不呼叫 clients.claim()，避免新版 SW 更新時「接管已開啟的頁面」而觸發整頁重新載入
// (實測診斷確認：舊版含 clients.claim() 會讓桌面瀏覽器/Android PWA 在 SW 更新時自動 reload，造成畫面內容閃一下就消失)。
const CACHE_NAME = 'stock-icons-v4';
const ICONS = ['/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE_NAME).then((c) => c.addAll(ICONS)));
  self.skipWaiting();   // 讓新版 SW 在「下一次載入」就生效（但不接管當前已開啟頁面）
});

self.addEventListener('activate', (e) => {
  // 清掉舊版快取名稱（含舊的 stock-app-shell-v2/v3，那些會攔截 HTML）
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))));
  // 刻意不呼叫 clients.claim()：不主動接管已開啟頁面，杜絕控制權變更觸發的重新載入
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // 只有 App 圖示走快取(加速安裝後啟動)；HTML、API、Yahoo/SEC 資料等一律「不呼叫 respondWith」→ 瀏覽器用預設網路行為，SW 完全不碰頁面
  if (e.request.method === 'GET' && ICONS.some((p) => url.pathname === p)) {
    e.respondWith(caches.match(e.request).then((c) => c || fetch(e.request)));
  }
});
