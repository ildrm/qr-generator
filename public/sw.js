const CACHE = 'qrlab-__QR_BUILD_CACHE__'
self.addEventListener('install', event => {
  event.waitUntil(fetch('./precache-manifest.json')
    .then(response => { if (!response.ok) throw new Error('Offline manifest unavailable'); return response.json() })
    .then(assets => caches.open(CACHE).then(cache => cache.addAll(['./', './index.html', './manifest.webmanifest', './favicon.svg', './precache-manifest.json', ...assets])))
    .then(() => self.skipWaiting()))
})
self.addEventListener('activate', event => { event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())) })
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) return
  event.respondWith(caches.match(event.request.url, { ignoreVary: true }).then(hit => hit || fetch(event.request).then(response => { if (response.ok) { const copy=response.clone(); caches.open(CACHE).then(cache => cache.put(event.request,copy)) } return response })))
})
