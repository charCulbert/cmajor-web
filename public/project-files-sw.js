const CACHE_NAME = "cmajor-web-project-files-v1";
const PROJECT_PREFIX = new URL("__cmajor_project__/", self.registration.scope).pathname;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (event) => {
  if (event.request.cache === "only-if-cached" && event.request.mode !== "same-origin") return;
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  const url = new URL(request.url);
  let response;

  if (url.origin === self.location.origin && url.pathname.startsWith(PROJECT_PREFIX)) {
    const cache = await caches.open(CACHE_NAME);
    response = await cache.match(request) || new Response("Project file not found", { status: 404 });
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
