const CACHE = 'rebecca-feed-planner-v5';
const CORE = [
  './',
  './index.html',
  './styles.css?v=5',
  './initial-posts.js?v=5',
  './app.js?v=5',
  './manifest.webmanifest',
  './assets/profile.jpg',
  './assets/icon-180.png',
  './assets/icon-192.png',
  './assets/icon-512.png',
  './assets/highlights/dolomites.jpg',
  './assets/highlights/rebecca.jpg',
  './assets/highlights/corfu.jpg',
  './assets/highlights/heart.jpg',
  './assets/highlights/italy.jpg'
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.allSettled(CORE.map(async url => {
      try {
        const response = await fetch(url, { cache: 'reload' });
        if (response.ok) await cache.put(url, response.clone());
      } catch (_) {}
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  const isAppFile = event.request.mode === 'navigate' || /\.(?:html|js|css|json|webmanifest)$/.test(url.pathname);
  if (isAppFile) {
    event.respondWith((async () => {
      try {
        const response = await fetch(event.request, { cache: 'no-store' });
        if (response.ok) {
          const cache = await caches.open(CACHE);
          cache.put(event.request, response.clone()).catch(() => {});
        }
        return response;
      } catch (_) {
        const cached = await caches.match(event.request, { ignoreSearch: false }) ||
          (event.request.mode === 'navigate' ? await caches.match('./index.html') : null);
        return cached || Response.error();
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(event.request);
    const networkPromise = fetch(event.request, { cache: 'no-cache' }).then(async response => {
      if (response.ok) {
        const cache = await caches.open(CACHE);
        cache.put(event.request, response.clone()).catch(() => {});
      }
      return response;
    }).catch(() => null);
    if (cached) {
      event.waitUntil(networkPromise.then(() => {}));
      return cached;
    }
    return await networkPromise || Response.error();
  })());
});
