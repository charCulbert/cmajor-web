const CACHE_NAME = "cmajor-web-project-files-v1";
const COMPILER_ASSET_CACHE = "cmajor-web-compiler-assets-1.0.3178-v1";
const PROJECT_PREFIX = new URL("__cmajor_project__/", self.registration.scope).pathname;
const COMPILER_ASSET_PREFIX = new URL("cmaj_api/", self.registration.scope).pathname;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (event) => {
  if (event.request.cache === "only-if-cached" && event.request.mode !== "same-origin") return;
  event.respondWith(handleRequest(event));
});

async function handleRequest(event) {
  const request = event.request;
  const url = new URL(request.url);
  let response;

  if (url.origin === self.location.origin && url.pathname.startsWith(PROJECT_PREFIX)) {
    const cache = await caches.open(CACHE_NAME);
    response = await cache.match(request) || new Response("Project file not found", { status: 404 });
  } else if (url.origin === self.location.origin && url.pathname.startsWith(COMPILER_ASSET_PREFIX)) {
    const cache = await caches.open(COMPILER_ASSET_CACHE);
    response = await cache.match(request);
    if (!response) {
      response = await fetch(request);
      if (response.ok) event.waitUntil(cache.put(request, response.clone()).catch(() => {}));
    }
  } else {
    response = await fetch(request);
  }

  if (response.type === "opaque" || response.type === "opaqueredirect") return response;
  const headers = new Headers(response.headers);
  headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
