/* CloudVault service worker — network-first for code, pre-cache only immutable assets.
   Why v16 is the LAST version bump you should ever need: previous versions pre-cached
   CSS/JS into SHELL_CACHE, and caches.match() returned those stale copies before
   checking RUNTIME_CACHE. Now CSS/JS go network-first, so every deploy is picked up
   on the next request without bumping VERSION. */
const VERSION = 'cv-sw-v17';
const SHELL_CACHE = `${VERSION}-shell`;
const RUNTIME_CACHE = `${VERSION}-runtime`;

// Only truly immutable assets here — never CSS/JS that ship with deploys.
const SHELL_ASSETS = [
  '/static/icons/icon-192.png',
  '/static/icons/icon-512.png',
  '/static/icons/apple-touch-icon.png',
  '/static/manifest.webmanifest',
  '/offline'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      Promise.all(
        SHELL_ASSETS.map((url) =>
          cache.add(url).catch(() => null)
        )
      )
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim()).then(async () => {
      // Force-reload any controlled tabs so they pick up the fresh shell
      // instead of waiting until the user closes/reopens them.
      const clients = await self.clients.matchAll({ type: 'window' });
      for (const c of clients) {
        try { c.navigate(c.url); } catch (_) {}
      }
    })
  );
});

function isStaticAsset(url) {
  return url.pathname.startsWith('/static/');
}

function isApiRequest(url) {
  return url.pathname.startsWith('/api/');
}

function isNavigation(request) {
  return request.mode === 'navigate' ||
    (request.method === 'GET' && request.headers.get('accept')?.includes('text/html'));
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // API: network-first, no cache (auth-sensitive)
  if (isApiRequest(url)) return;

  // Static: network-first with runtime-cache fallback. Deploys are picked up
  // immediately; offline still works for previously-fetched assets.
  if (isStaticAsset(url)) {
    event.respondWith(
      fetch(req).then((res) => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(RUNTIME_CACHE).then((c) => c.put(req, clone));
        }
        return res;
      }).catch(() =>
        caches.match(req, { cacheName: RUNTIME_CACHE }).then((cached) =>
          cached || caches.match(req)
        )
      )
    );
    return;
  }

  // HTML navigation: network-first, fall back to cache, then offline page
  if (isNavigation(req)) {
    event.respondWith(
      fetch(req).then((res) => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(RUNTIME_CACHE).then((c) => c.put(req, clone));
        }
        return res;
      }).catch(() =>
        caches.match(req).then((cached) =>
          cached || caches.match('/offline')
        )
      )
    );
  }
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
