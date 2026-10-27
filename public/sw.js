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
// auth/me is kept so the shell knows whose app it is offline. All of it is
// personal: it goes on sign-out, and as soon as the server says the session
// is gone (see networkFirst).
const CACHEABLE_API = new RegExp(
  "^/api/(tasks|tags|projects|notes|inbox$|inbox\\?|stats|logbook|nearby|calendar/today|assistant/(plan|briefing|review)|settings$|google/status|auth/me$)",
);
// Set on an API answer served from DATA_CACHE, so the page can tell a stale
// copy from a live one (src/lib/offline.ts reads it).
const FROM_CACHE_HEADER = "x-donex-cache";

// Bumped whenever the personal data goes (sign-out, a 401). A fetch that
// started before the purge must not write its answer back after it.
let dataEpoch = 0;

function putData(request, response, epoch) {
  if (epoch !== dataEpoch) return;
  caches
    .open(DATA_CACHE)
    .then((cache) => {
      if (epoch === dataEpoch) return cache.put(request, response);
    })
    .catch(() => undefined);
}

// Content-hashed bundles and icons hold nothing personal; everything else in
// DATA_CACHE (API answers, visited pages) belongs to whoever was signed in.
function isSharedAsset(pathname) {
  return pathname.startsWith("/_next/static") || pathname.startsWith("/icons");
}

async function clearPersonalData() {
  dataEpoch += 1;
  try {
    const cache = await caches.open(DATA_CACHE);
    const entries = await cache.keys();
    await Promise.all(
      entries
        .filter((r) => !isSharedAsset(new URL(r.url).pathname))
        .map((r) => cache.delete(r)),
    );
  } catch (err) {
    /* best effort; the page purges too */
  }
}

function markFromCache(response) {
  const headers = new Headers(response.headers);
  headers.set(FROM_CACHE_HEADER, "1");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

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
  const epoch = dataEpoch;
  return fetch(request)
    .then((response) => {
      if (response && response.status === 200) {
        putData(request, response.clone(), epoch);
      } else if (response && response.status === 401) {
        // Signed out: nothing cached belongs to anyone signed in any more.
        clearPersonalData();
      } else if (response && response.status === 403) {
        // Not this session's to see: the copy kept for whoever could see it
        // must not keep answering offline.
        caches
          .open(DATA_CACHE)
          .then((cache) => cache.delete(request))
          .catch(() => undefined);
      }
      return response;
    })
    .catch(async () => {
      const cached = await caches.match(request, { ignoreSearch: false });
      if (cached) return markFromCache(cached);
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
    const epoch = dataEpoch;
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.status === 200) putData(request, response.clone(), epoch);
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
  // Sign-out (src/lib/offline.ts): drop the signed-in person's cached data,
  // then answer on the port so the page knows it is gone.
  if (event.data && event.data.type === "CLEAR_DATA") {
    const port = event.ports && event.ports[0];
    event.waitUntil(clearPersonalData().then(() => port && port.postMessage({ ok: true })));
  }
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
      // Reminders reuse one tag per task (task-<id>), so a repeat or a
      // rescheduled reminder replaces the one still showing. Without this
      // the replacement arrives silently: no sound, no vibration.
      renotify: !!data.tag,
      data: { url: data.url },
    }),
  );
});

// The browser can rotate a subscription while the app is closed; tell the
// server now rather than on the next app load. Same body as pushApi.subscribe
// (src/app/api/push/subscribe/route.ts).
self.addEventListener("pushsubscriptionchange", (event) => {
  const resubscribe = event.newSubscription
    ? Promise.resolve(event.newSubscription)
    : event.oldSubscription && event.oldSubscription.options
      ? // Some browsers hand over only the old one; subscribe again with its options.
        self.registration.pushManager.subscribe(event.oldSubscription.options)
      : Promise.resolve(null);
  event.waitUntil(
    resubscribe
      .then((subscription) => {
        if (!subscription) return undefined;
        return fetch("/api/push/subscribe", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ subscription: subscription.toJSON() }),
        });
      })
      .catch(() => undefined),
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
