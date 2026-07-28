/* Sturm Energie · Service Worker
   Strategie:
   - HTML/Navigation: "network-first" -> Updates erscheinen sofort, offline fällt auf Cache zurück
   - Statische Assets (Fonts, Icons): "cache-first" -> schnelle Ladezeiten
   Cache-Version bei größeren Änderungen erhöhen (v1 -> v2), damit alte Caches gelöscht werden.
*/
const CACHE = 'sturm-energie-v1';
const CORE = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png'
];

// Installation: Kern-Dateien vorab in den Cache legen
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(CORE))
      .then(() => self.skipWaiting())
      .catch(() => {})
  );
});

// Aktivierung: alte Caches entfernen
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Anfragen abfangen
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const isHTML = req.mode === 'navigate' ||
    (req.headers.get('accept') || '').includes('text/html');

  // 1) HTML: network-first (immer aktuelle Inhalte, offline Fallback)
  if (isHTML) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('/', copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(req).then((r) => r || caches.match('/')))
    );
    return;
  }

  // 2) Alles andere: cache-first, dann Netzwerk (und cachen)
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((res) => {
          const sameOrigin = url.origin === self.location.origin;
          const isFont = url.host.includes('gstatic') || url.host.includes('googleapis');
          if (res && (res.ok || res.type === 'opaque') && (sameOrigin || isFont)) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match(req));
    })
  );
});
