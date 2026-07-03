/* Roybal Field Forms — service worker
   Strategy: navigations = network-first (always latest HTML when online);
   same-origin assets = stale-while-revalidate (instant load, refreshes in
   the background so updates land on the next open); large vendor files =
   cache-first. This makes new deploys self-update without manual cache bumps. */
const CACHE = "roybal-field-v52";

const CORE = [
  ".", "index.html", "manifest.webmanifest",
  "css/app.css", "css/print.css",
  "js/app.js", "js/core.js", "js/model.js", "js/formkit.js", "js/forms.js",
  "js/pdf.js", "js/qr.js", "js/config.js", "js/supa.js", "js/sync.js",
  // AI backbone (Steps A–E): completeness panel, job spine, voice capture, tech identity
  "js/completeness.js", "js/spine.js", "js/ai.js", "js/voice.js", "js/tech.js", "js/narrative.js",
  "js/qbtime.js",
  "assets/emblem-mark.svg", "assets/icon-16.png", "assets/icon-32.png",
  "assets/icon-180.png", "assets/icon-192.png", "assets/icon-512.png", "assets/icon-512-maskable.png",
];
const OPTIONAL = [
  "assets/vendor/pdfjs/pdf.min.mjs",
  "assets/vendor/pdfjs/pdf.worker.min.mjs",
  "assets/vendor/qrcode/qrcode.mjs",
  "assets/logo-full.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    // fetch every asset fresh from the network (bypass the HTTP cache)
    const fresh = (u) => fetch(new Request(u, { cache: "reload" })).then((r) => r.ok && c.put(u, r.clone()));
    await Promise.all(CORE.map((u) => fresh(u).catch(() => c.add(u).catch(() => {}))));
    await Promise.allSettled(OPTIONAL.map((u) => fresh(u).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

function swr(request) {
  return caches.open(CACHE).then((cache) =>
    cache.match(request).then((cached) => {
      const network = fetch(request, { cache: "no-cache" }).then((res) => {
        if (res && res.status === 200) cache.put(request, res.clone());
        return res;
      }).catch(() => cached);
      return cached || network;
    }));
}

self.addEventListener("fetch", (e) => {
  const { request } = e;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  // HTML navigations: network-first so the app is always current when online
  if (request.mode === "navigate") {
    e.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put("index.html", copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(request).then((r) => r || caches.match("index.html")))
    );
    return;
  }

  // same-origin assets: stale-while-revalidate (fast + self-updating)
  if (url.origin === self.location.origin) {
    e.respondWith(swr(request));
    return;
  }

  // anything else: cache-first
  e.respondWith(caches.match(request).then((c) => c || fetch(request)));
});
