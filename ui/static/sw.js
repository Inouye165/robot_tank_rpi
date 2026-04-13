const CACHE_NAME = 'robot-tank-react-shell-v1';
const APP_SHELL = [
  '/',
  '/static/dist/app.js',
  '/static/dist/app.css',
  '/static/dist/manifest.webmanifest',
  '/static/dist/icon-tank.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') {
    return;
  }

  const requestUrl = new URL(event.request.url);
  const isNavigation = event.request.mode === 'navigate';
  const isAppAsset = requestUrl.origin === self.location.origin && (
    requestUrl.pathname === '/' || requestUrl.pathname.startsWith('/static/dist/')
  );

  if (!isNavigation && !isAppAsset) {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (isAppAsset && response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(event.request);
        if (cached) {
          return cached;
        }
        if (isNavigation) {
          return caches.match('/');
        }
        throw new Error(`No cached response for ${event.request.url}`);
      })
  );
});