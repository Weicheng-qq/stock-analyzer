// Service Worker：網頁本身(HTML)用「網路優先」確保永遠拿到最新版本；圖示等靜態資源用「快取優先」加速；API資料一律不快取
const CACHE_NAME = 'stock-app-shell-v3';
const APP_SHELL = ['/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE_NAME).then((c) => c.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/api/') || e.request.method !== 'GET') return; // API/資料一律走網路，不快取

  const isPage = e.request.mode === 'navigate' || url.pathname === '/';
  if (isPage) {
    // 網路優先：每次都拿最新版HTML，只有離線時才退回快取
    e.respondWith(
      fetch(e.request)
        .then((res) => { const clone = res.clone(); caches.open(CACHE_NAME).then((c) => c.put(e.request, clone)); return res; })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // 靜態資源(圖示等)：快取優先，背景更新
  e.respondWith(
    caches.match(e.request).then((cached) => {
      const fetchPromise = fetch(e.request)
        .then((res) => { const clone = res.clone(); caches.open(CACHE_NAME).then((c) => c.put(e.request, clone)); return res; })
        .catch(() => cached);
      return cached || fetchPromise;
    })
  );
});
