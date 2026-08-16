/* DoneX service worker */
// Registered as /sw.js?v=<build id>, so each deploy gets its own asset cache
// and the activate step below purges every older one — no deploy can leave
// stale JS chunks being served cache-first forever.
const BUILD = new URL(self.location.href).searchParams.get("v") || "v1";
const VERSION = `donex-${BUILD}`;
// Last-known data + visited pages. Deliberately NOT per-build: it is what the
// app runs on when offline, and losing it on every deploy would defeat that.
const DATA_CACHE = "donex-data-v1";
const OFFLINE_URL = "/offline";
const PRECACHE = [
  OFFLINE_URL,
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/maskable-512.png",
  "/icons/badge-96.png",
];

// Read endpoints that make the app browsable offline. Everything else on
// /api (auth, chat streams, health/update checks, exports) stays live-only.
const CACHEABLE_API = new RegExp(
  "^/api/(tasks|tags|projects|notes|inbox$|inbox\\?|stats|logbook|nearby|calendar/today|assistant/(plan|briefing|review)|settings$|google/status)",
);

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.addAll(PRECACHE).catch(() => undefined))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== VERSION && k !== DATA_CACHE)
            .map((k) => caches.delete(k)),
        ),
      )
      .then(pruneStatic)
      .then(() => self.clients.claim()),
  );
});

// Hashed chunks accumulate across deploys (they must survive them so cached
// pages can hydrate offline); when the pile gets tall, start fresh — it
// refills from the network on the next online visit.
async function pruneStatic() {
  try {
    const cache = await caches.open(DATA_CACHE);
    const entries = await cache.keys();
    const statics = entries.filter((r) => new URL(r.url).pathname.startsWith("/_next/static"));
    if (statics.length > 400) {
      await Promise.all(statics.map((r) => cache.delete(r)));
    }
  } catch (err) {
    /* pruning is best-effort */
  }
}

/** Network first; successes refresh DATA_CACHE, failures fall back to it. */
function networkFirst(request, fallbackUrl) {
  return fetch(request)
    .then((response) => {
      if (response && response.status === 200) {
        const copy = response.clone();
        caches.open(DATA_CACHE).then((cache) => cache.put(request, copy));
      }
      return response;
    })
    .catch(async () => {
      const cached = await caches.match(request, { ignoreSearch: false });
      if (cached) return cached;
      if (fallbackUrl) {
        const fallback = await caches.match(fallbackUrl);
        if (fallback) return fallback;
      }
      return Response.error();
    });
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith("/api")) {
    const key = url.pathname + url.search;
    if (CACHEABLE_API.test(key)) {
      event.respondWith(networkFirst(request));
    }
    return;
  }

  if (request.mode === "navigate") {
    // Visited pages are cached, so the app opens offline to real content;
    // a never-visited page falls back to Today, then the offline screen.
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.status === 200) {
            const copy = response.clone();
            caches.open(DATA_CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(async () => {
          const cached =
            (await caches.match(request, { ignoreSearch: true })) ||
            (await caches.match("/today")) ||
            (await caches.match(OFFLINE_URL));
          return cached ?? Response.error();
        }),
    );
    return;
  }

  if (url.pathname.startsWith("/_next/static") || url.pathname.startsWith("/icons")) {
    // Content-hashed, so cache-first is safe — and stored in DATA_CACHE so
    // pages cached before a deploy can still hydrate offline after it.
    event.respondWith(
      caches.match(request).then((cached) => {
        const network = fetch(request)
          .then((response) => {
            if (response && response.status === 200) {
              const copy = response.clone();
              caches.open(DATA_CACHE).then((cache) => cache.put(request, copy));
            }
            return response;
          })
          .catch(() => cached);
        return cached || network;
      }),
    );
  }
});

self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (err) {
    data = { title: "DoneX", body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "DoneX";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "",
      icon: "/icons/icon-192.png",
      // Monochrome mask — Android renders only its alpha channel in the
      // status bar; a colour icon here shows up as a featureless box.
      badge: "/icons/badge-96.png",
      tag: data.tag,
      data: { url: data.url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/today";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) {
          if ("navigate" in client) client.navigate(target).catch(() => undefined);
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
