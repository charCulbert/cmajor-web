export const COMPILE_CACHE_NAME = "cmajor-web-compiled-1.0.3178-v1";
const MAX_CACHE_ENTRIES = 8;
const MAX_CACHE_BYTES = 48 * 1024 * 1024;

function bytesFor(content) {
  if (typeof content === "string") return new TextEncoder().encode(content);
  if (content instanceof ArrayBuffer) return new Uint8Array(content);
  if (ArrayBuffer.isView(content)) return new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
  return new TextEncoder().encode(String(content ?? ""));
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", bytesFor(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function compileCacheKey(files, manifestPath) {
  const entries = [];
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path)))
    entries.push([file.path, await sha256(file.content)]);
  return sha256(JSON.stringify({ manifestPath, entries }));
}

function cacheRequest(key) {
  return new Request(new URL(`__cmajor_compiled__/${key}`, location.origin));
}

export async function readCompiledResult(key) {
  if (!("caches" in globalThis)) return null;
  try {
    const response = await (await caches.open(COMPILE_CACHE_NAME)).match(cacheRequest(key));
    if (!response) return null;
    return { code: await response.text(), version: response.headers.get("x-cmajor-version") || "", cached: true };
  } catch {
    return null;
  }
}

export async function writeCompiledResult(key, result) {
  if (!("caches" in globalThis) || !result?.code) return;
  try {
    const cache = await caches.open(COMPILE_CACHE_NAME);
    const size = new Blob([result.code]).size;
    await cache.put(cacheRequest(key), new Response(result.code, { headers: {
      "content-type": "text/javascript",
      "x-cmajor-version": result.version || "",
      "x-cache-created": String(Date.now()),
      "x-cache-bytes": String(size),
    } }));
    await trimCompiledResults(cache);
  } catch {
    // CacheStorage may be unavailable or full; compilation still succeeded.
  }
}

async function trimCompiledResults(cache) {
  const records = await Promise.all((await cache.keys()).map(async (request) => {
    const response = await cache.match(request);
    return {
      request,
      created: Number(response?.headers.get("x-cache-created")) || 0,
      size: Number(response?.headers.get("x-cache-bytes")) || 0,
    };
  }));
  records.sort((a, b) => b.created - a.created);
  let total = 0;
  for (const [index, record] of records.entries()) {
    total += record.size;
    if (index >= MAX_CACHE_ENTRIES || total > MAX_CACHE_BYTES) await cache.delete(record.request);
  }
}
