const CACHE_NAME = 'rasid-pwa-shell-v1';
const APP_SHELL = [
  '/',
  '/admin',
  '/manifest.webmanifest',
  '/firebase-config.js',
  '/assets/rasid-icon-192.png',
  '/assets/rasid-icon-512.png',
  '/assets/ministry-education.svg'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key.startsWith('rasid-pwa-shell-') && key !== CACHE_NAME).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cacheUrl = new URL(url.origin + url.pathname);
      try {
        const response = await fetch(request);
        if (response.ok && (response.headers.get('content-type') || '').includes('text/html')) {
          await cache.put(cacheUrl, response.clone());
        }
        return response;
      } catch (error) {
        const cached = await cache.match(cacheUrl)
          || await cache.match(url.pathname.startsWith('/admin') ? '/admin' : '/');
        if (cached) return cached;
        return new Response('<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>راصد — غير متصل</title><body style="font-family:sans-serif;padding:2rem;text-align:center"><h1>لا يوجد اتصال بالإنترنت</h1><p>أعد الاتصال ثم حاول فتح راصد مرة أخرى.</p></body></html>', {
          status: 503,
          headers: { 'Content-Type': 'text/html; charset=utf-8' }
        });
      }
    })());
    return;
  }

  const isShellAsset = url.pathname === '/firebase-config.js'
    || url.pathname === '/manifest.webmanifest'
    || url.pathname.startsWith('/assets/');
  if (!isShellAsset) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request);
    const refresh = fetch(request).then(response => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    });
    return cached || refresh;
  })());
});
