/* RuckOps service worker — network-first for same-origin assets.
 *
 * Why network-first: cache-first locks users to whatever build they first
 * installed. With an actively-developed app, that means new features and
 * bug fixes never reach the device until something invalidates the cache.
 * Network-first fetches the latest every load and falls back to cache only
 * when offline. The user always sees the newest deploy.
 *
 * Tiles stay cache-first (no point redownloading the same map every workout).
 */

// Bump this on every deploy to clear old caches.
const CACHE = 'ruckops-2026-05-12a';

const CORE = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(CORE)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE && !k.startsWith(CACHE)).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const isTile = url.host.endsWith('tile.openstreetmap.org');

  // Map tiles: cache-first (saves data; tiles don't change).
  if (isTile) {
    event.respondWith(
      caches.match(req).then(cached => cached || fetch(req).then(resp => {
        const clone = resp.clone();
        caches.open(CACHE + '-tiles').then(c => c.put(req, clone)).catch(() => {});
        return resp;
      }))
    );
    return;
  }

  // Same-origin: network-first. Always fetch latest; cache as offline fallback.
  if (url.origin === location.origin) {
    event.respondWith(
      fetch(req).then(resp => {
        if (resp && resp.ok) {
          const clone = resp.clone();
          caches.open(CACHE).then(c => c.put(req, clone)).catch(() => {});
        }
        return resp;
      }).catch(() => caches.match(req).then(cached => cached || caches.match('./index.html')))
    );
    return;
  }

  // Cross-origin (fonts, Leaflet CDN): network-first with cache fallback.
  event.respondWith(
    fetch(req).then(resp => {
      if (resp && resp.ok) {
        const clone = resp.clone();
        caches.open(CACHE + '-cdn').then(c => c.put(req, clone)).catch(() => {});
      }
      return resp;
    }).catch(() => caches.match(req))
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
