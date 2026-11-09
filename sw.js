// App-shell cache only. Market data is always fetched live (never cached).
const C = 'grokdesk-v2';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'engine/core.js', 'engine/engine.js', 'engine/data.js', 'engine/prior.js', 'manifest.json', 'icons/icon.svg', 'icons/icon-192.png'];
self.addEventListener('install', (e) => e.waitUntil(caches.open(C).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== C).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (u.origin !== location.origin || u.pathname.endsWith('.json')) return; // live data + tape go to network
  e.respondWith(fetch(e.request).then((r) => { const cp = r.clone(); caches.open(C).then((c) => c.put(e.request, cp)); return r; }).catch(() => caches.match(e.request)));
});
