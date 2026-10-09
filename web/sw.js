// Service worker: keeps the app itself available offline.
// The London data pack (data/) is stored separately by the app (OPFS), so it is never cached here.
const VERSION = "__VERSION__";
const APP_CACHE = "lsr-app-" + VERSION;
const RUNTIME = "lsr-runtime";
const PRECACHE = __PRECACHE__;

self.addEventListener("install", (ev) => {
  ev.waitUntil((async () => {
    const c = await caches.open(APP_CACHE);
    await c.addAll(PRECACHE.map((p) => new Request(p, { cache: "reload" })));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (ev) => {
  ev.waitUntil((async () => {
    for (const k of await caches.keys()) {
      if (k.startsWith("lsr-app-") && k !== APP_CACHE) await caches.delete(k);
    }
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (ev) => {
  const req = ev.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  const path = url.pathname.slice(new URL(self.registration.scope).pathname.length);
  // data pack: always from the network (map byte ranges and update checks)
  if (path.startsWith("data/")) return;
  if (req.mode === "navigate") {
    ev.respondWith((async () => {
      try {
        return await fetch(req);
      } catch {
        const c = await caches.open(APP_CACHE);
        return (await c.match("index.html")) || Response.error();
      }
    })());
    return;
  }
  ev.respondWith((async () => {
    const hit = await caches.match(req, { ignoreSearch: true });
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res.ok && path.startsWith("assets/")) {
        const c = await caches.open(RUNTIME);
        c.put(req, res.clone());
      }
      return res;
    } catch {
      // a glyph range that was never downloaded: let the map render without it
      if (path.endsWith(".pbf")) return new Response(new ArrayBuffer(0), { status: 200 });
      return Response.error();
    }
  })());
});
