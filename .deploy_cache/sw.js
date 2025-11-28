const CACHE_NAME = 'p1-v10-final';
const ASSETS = [
  './',
  './index.html',
  './easytier.js',
  './manifest.json',
  'https://cdn.jsdelivr.net/npm/peerjs@1.5.0/dist/peerjs.min.js'
];

self.addEventListener('install', e => e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(ASSETS))));
self.addEventListener('fetch', e => e.respondWith(caches.match(e.request).then(r => r || fetch(e.request))));