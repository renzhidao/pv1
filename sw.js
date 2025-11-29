const CACHE_NAME = 'p1-v119-final';
const ASSETS = [
  './', 
  './index.html', 
  './easytier.js',
  './manifest.json',
  'https://cdn.jsdelivr.net/npm/peerjs@1.5.0/dist/peerjs.min.js',
  'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f4e1.png'
];

self.addEventListener('install', e => e.waitUntil(
  caches.open(CACHE_NAME).then(c => c.addAll(ASSETS))
));

self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(keys => Promise.all(
    keys.map(k => k !== CACHE_NAME ? caches.delete(k) : Promise.resolve())
  ))
));

self.addEventListener('fetch', e => e.respondWith(
  fetch(e.request).catch(() => caches.match(e.request))
));