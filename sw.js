// Network first so updates show up right away; falls back to the cache when offline.
// Product lookups are never cached.
const VERSION = 40;
const CACHE = `homestock-v${VERSION}`;
const SHELL = [
  './', 'index.html', `styles.css?v=${VERSION}`, `app.js?v=${VERSION}`, `parser.js?v=${VERSION}`, `sync.js?v=${VERSION}`, `merge.js?v=${VERSION}`, `config.js?v=${VERSION}`, 'scan-worker.js',
  'manifest.webmanifest', 'icon.svg', 'apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  // cache: 'reload' skips the browser's own cache so the offline copy is this version's files.
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  const sameOrigin = url.origin === location.origin;
  if (!sameOrigin && !['unpkg.com', 'cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'].includes(url.hostname)) return;
  // Our own files are always checked with the server (a quick "not modified" when nothing
  // changed), so a page never runs a mix of old and new files after an update.
  const request = sameOrigin ? fetch(url.href, { cache: 'no-cache', credentials: 'same-origin' }) : fetch(e.request);
  e.respondWith(
    request
      .then((res) => {
        const copy = res.clone();
        if (res.ok) caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })),
  );
});
