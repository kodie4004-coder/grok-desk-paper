// App-shell cache only. Market data is always fetched live (never cached).
const C = 'grokdesk-v19';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'engine/core.js', 'engine/engine.js', 'engine/data.js', 'engine/prior.js', 'engine/strategies.js', 'engine/slot-prior.js', 'engine/predict.js', 'engine/predict-prior.js', 'engine/majors.js', 'engine/majors-prior.js', 'engine/active.js', 'engine/kalshi.js', 'engine/kalshi-prior.js', 'engine/arena.js', 'engine/game.js', 'engine/scalp.js', 'engine/filings.js', 'engine/gate-prior.js', 'engine/store.js', 'engine/meme.js', 'engine/roles.js', 'engine/trainer.js', 'manifest.json', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png', 'icons/favicon-32.png', 'icons/favicon.ico', 'icons/pump.svg', 'icons/fomo.svg', 'icons/dex.svg', 'icons/solscan.svg'];
self.addEventListener('install', (e) => e.waitUntil(caches.open(C).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== C).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (u.origin !== location.origin || u.pathname.endsWith('.json') || u.pathname.endsWith('.jsonl') || u.pathname.endsWith('.webm') || u.pathname.endsWith('.mp4')) return; // live data, journal, and the splash loop go to network
  e.respondWith(fetch(e.request).then((r) => { const cp = r.clone(); caches.open(C).then((c) => c.put(e.request, cp)); return r; }).catch(() => caches.match(e.request)));
});
