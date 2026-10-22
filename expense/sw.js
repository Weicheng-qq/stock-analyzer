// 隨手記帳 Service Worker —— 只為了「沒網路也打得開」。
// 策略：一律先抓網路（拿到就順手更新快取），抓不到才用快取 → 永遠不會卡在舊版。
// 刻意不呼叫 clients.claim()、不主動重新整理頁面（本網域曾因 SW 重載迴圈出事，見根目錄 sw.js）。
const CACHE = 'expense-v2';
const FILES = ['./', 'index.html', 'style.css', 'app.js', 'parse.js', 'manifest.json', 'icon.svg', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) =>
    Promise.all(keys.filter((k) => k.startsWith('expense-') && k !== CACHE).map((k) => caches.delete(k)))));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match('index.html')))
  );
});
