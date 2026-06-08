/* Roybal Field Forms — service worker (offline-first app shell) */
const CACHE = "roybal-field-v1";
const ASSETS = [
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
  "assets/logo.svg",
  "assets/icon.svg",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
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
