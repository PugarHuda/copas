// Copas service worker: offline fallback page + immutable build assets. Never caches API, RPC or any cross-origin
// response, so balances, positions and prices always come from the network.
const CACHE = "copas-v1";
const OFFLINE = "/offline";

self.addEventListener("install", (e) => {
  e.waitUntil(
    (async () => {
      const c = await caches.open(CACHE);
      const res = await fetch(OFFLINE, { cache: "reload" });
      await c.put(OFFLINE, res.clone());
      // the offline page's own stylesheets, so it renders styled with no network
      const css = [...(await res.text()).matchAll(/href="(\/_next\/static\/[^"]+\.css)"/g)].map((m) => m[1]);
      await c.addAll(["/icons/icon-192.png", ...css]);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    (async () => {
      for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return; // network only, never cached
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).catch(() => caches.match(OFFLINE)));
    return;
  }
  // content-hashed build output and icons never change under the same URL
  if (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/icons/")) {
    e.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(req, copy));
            }
            return res;
          }),
      ),
    );
  }
});
