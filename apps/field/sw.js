/* Roybal Field Forms — service worker (offline-first app shell) */
const CACHE = "roybal-field-v2";

/* core shell — must all cache for the app to work offline */
const CORE = [
  ".",
  "index.html",
  "manifest.webmanifest",
  "css/app.css",
  "css/print.css",
  "js/app.js",
  "js/core.js",
  "js/model.js",
  "js/formkit.js",
  "js/forms.js",
  "js/pdf.js",
  "assets/favicon-16.png",
  "assets/favicon-32.png",
  "assets/apple-touch-icon.png",
  "assets/mstile-150.png",
];

/* large optional assets — floor-plan PDF engine; cached best-effort */
const OPTIONAL = [
  "assets/vendor/pdfjs/pdf.min.mjs",
  "assets/vendor/pdfjs/pdf.worker.min.mjs",
  "assets/logo-full.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await c.addAll(CORE);
    await Promise.allSettled(OPTIONAL.map((u) => c.add(u)));
    self.skipWaiting();
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* cache-first for app shell, network fallback; navigations fall back to index.html */
self.addEventListener("fetch", (e) => {
  const { request } = e;
  if (request.method !== "GET") return;
  e.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
          return res;
        })
        .catch(() => {
          if (request.mode === "navigate") return caches.match("index.html");
        });
    })
  );
});
