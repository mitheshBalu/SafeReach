importScripts("store.js");

const APP_CACHE = "safereach-shell-v10";
const TILE_CACHE = "shelter-tiles-v2";
const TILE_LIMIT = 900;

const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./store.js",
  "./i18n.js",
  "./manifest.json",
  "./vendor/leaflet/leaflet.css",
  "./vendor/leaflet/leaflet.js",
  "./vendor/leaflet/images/marker-icon.png",
  "./vendor/leaflet/images/marker-icon-2x.png",
  "./vendor/leaflet/images/marker-shadow.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/logo.png"
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(APP_CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== APP_CACHE && k !== TILE_CACHE).map((k) => caches.delete(k))
        )
      )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);

  if (url.hostname.endsWith("tile.openstreetmap.org")) {
    e.respondWith(
      caches.open(TILE_CACHE).then(async (cache) => {
        const hit = await cache.match(e.request);
        if (hit) return hit;
        try {
          const resp = await fetch(e.request);
          cache.put(e.request, resp.clone());
          trimCache(TILE_CACHE, TILE_LIMIT);
          return resp;
        } catch {
          return hit || Response.error();
        }
      })
    );
    return;
  }

  if (url.origin === self.location.origin && !url.pathname.startsWith("/api/")) {
    e.respondWith(
      caches.match(e.request).then((hit) => hit || fetch(e.request))
    );
    return;
  }

  e.respondWith(fetch(e.request).catch(() => caches.match(e.request) || Response.error()));
});

async function trimCache(name, max) {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  if (keys.length <= max) return;
  for (const k of keys.slice(0, keys.length - max)) await cache.delete(k);
}


self.addEventListener("periodicsync", (e) => {
  if (e.tag === "refresh") e.waitUntil(backgroundRefresh());
});

self.addEventListener("sync", (e) => {
  if (e.tag === "refresh-retry") e.waitUntil(backgroundRefresh());
});

self.addEventListener("message", (e) => {
  if (e.data?.type === "REFRESH_NOW") e.waitUntil(backgroundRefresh());
});

async function broadcast(msg) {
  const clients = await self.clients.matchAll();
  clients.forEach((c) => c.postMessage(msg));
}

async function backgroundRefresh() {
  const origin = await Store.getMeta("origin");
  const radius = (await Store.getMeta("radius")) || 50;
  if (!origin) return;

  await broadcast({ type: "SYNC_START" });
  try {
    const q = new URLSearchParams({
      lat: origin.lat, lon: origin.lon, radius, limit: 15
    });
    if (origin.state) q.set("state", origin.state);
    const resp = await fetch(`/api/bundle?${q}`);
    if (!resp.ok) throw new Error("bundle");
    const data = await resp.json();

    await Store.putAll(data.facilities);
    await Store.setMeta("updatedAt", data.generated_at);
    await Store.setMeta("sources", data.sources_used || []);
    await Store.setMeta("failed", data.sources_failed || []);
  } catch {
    // Leave saved data in place; the next tick retries.
  } finally {
    await broadcast({ type: "SYNC_DONE" });
  }
}
