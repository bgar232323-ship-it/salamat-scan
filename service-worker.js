/**
 * service-worker.js — offline app shell for Salamat Scan.
 *
 * Strategy: cache-first for every same-origin shell asset, with a background
 * refresh (stale-while-revalidate). Bump SHELL_VERSION when shell files change.
 */

const SHELL_VERSION = 'v4';
const SHELL_CACHE = `salamat-scan-shell-${SHELL_VERSION}`;

/** Every file the app needs to start and work offline (all relative paths). */
const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/style.css',
  './js/app.js',
  './js/scanner.js',
  './js/zxing.min.js',
  './fonts/Vazirmatn-Regular.woff2',
  './fonts/Vazirmatn-Medium.woff2',
  './fonts/Vazirmatn-Bold.woff2',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== SHELL_CACHE).map((key) => caches.delete(key)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;

  // Only handle same-origin GET requests; everything else (API, etc.) is passthrough.
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          // Keep a fresh copy of the shell for the next offline visit.
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached);

      // Cache-first: instant and fully offline-capable.
      return cached || network;
    })
  );
});
