const CACHE_NAME = "cmajor-web-project-files-v1";
const PROJECT_PREFIX = "/__cmajor_project__/";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (event) => {
  if (new URL(event.request.url).pathname.startsWith(PROJECT_PREFIX)) {
    event.respondWith(caches.open(CACHE_NAME).then(async (cache) => await cache.match(event.request) || new Response("Project file not found", { status: 404 })));
  }
});
