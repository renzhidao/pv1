const CACHE_NAME = 'p1-v121-allfix';

const CORE_ASSETS = [
  './',
  './index.html',
  './easytier.js',
  './manifest.json'
];

// 安装：逐个缓存核心资源，任一失败也不影响整体安装
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    for (const url of CORE_ASSETS) {
      try {
        await cache.add(url);
      } catch (e) {
        console.warn('[SW] Failed to cache', url, e);
      }
    }
  })());
});

// 激活：清理旧版本缓存
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.map(k => k !== CACHE_NAME ? caches.delete(k) : Promise.resolve())
    ))
  );
});

// 请求拦截：导航请求提供离线兜底，其它请求网络优先+缓存回退
self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);

  // 页面导航：网络优先，失败回退到缓存的壳 (index.html)
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        return fresh;
      } catch (e) {
        const cache = await caches.open(CACHE_NAME);
        const cached = await cache.match('./index.html');
        if (cached) return cached;
        return new Response('Offline', { status: 503, statusText: 'Offline' });
      }
    })());
    return;
  }

  // 同源 GET 资源：网络优先，并写入缓存；失败用缓存兜底
  if (url.origin === self.location.origin && req.method === 'GET') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(CACHE_NAME);
        cache.put(req, fresh.clone());
        return fresh;
      } catch (e) {
        const cached = await caches.match(req);
        if (cached) return cached;
        return new Response('Offline', { status: 503, statusText: 'Offline' });
      }
    })());
    return;
  }

  // 跨域 GET (CDN 等)：网络优先，如果成功则顺手缓存，失败时尝试缓存回退
  if (req.method === 'GET') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(CACHE_NAME);
        cache.put(req, fresh.clone());
        return fresh;
      } catch (e) {
        const cached = await caches.match(req);
        if (cached) return cached;
        return new Response('Offline', { status: 503, statusText: 'Offline' });
      }
    })());
  }
});