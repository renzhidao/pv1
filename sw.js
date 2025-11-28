self.addEventListener('install', () => {
  self.skipWaiting(); // 强制跳过等待
});

self.addEventListener('activate', event => {
  // 立即接管并删除所有旧缓存
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.map(key => caches.delete(key))
    ))
  );
  self.clients.claim();
});

// 不再拦截请求，直接走网络，确保你读到的是最新文件
self.addEventListener('fetch', () => {});