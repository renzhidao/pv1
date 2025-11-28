const CACHE_NAME = 'p1-v13-clean';
const ASSETS = [
  './',
  './index.html',
  './easytier.js',
  './manifest.json',
  'https://cdn.jsdelivr.net/npm/peerjs@1.5.0/dist/peerjs.min.js'
];

// 安装时立即接管
self.addEventListener('install', e => {
  self.skipWaiting(); 
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(ASSETS)));
});

// 激活时清理旧缓存
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.map(key => {
        if (key !== CACHE_NAME) return caches.delete(key);
      })
    ))
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => e.respondWith(fetch(e.request).catch(() => caches.match(e.request))));