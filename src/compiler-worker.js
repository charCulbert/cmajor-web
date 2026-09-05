// Upstream's general adapter imports DOM playback helpers at module scope. This
// worker-only copy removes that playback method but keeps the compiler API intact.
const compilerModuleURL = new URL("/cmaj_api/cmaj-embedded-compiler-worker.js", self.location.href).href;
const compilerModule = import(/* @vite-ignore */ compilerModuleURL);
let requestQueue = Promise.resolve();

self.postMessage({ type: "ready" });
self.addEventListener("message", ({ data }) => {
  requestQueue = requestQueue.then(() => compile(data));
});

async function compile(data) {
  const { id, purpose = "build", files, manifestPath, resourceRoot } = data;
  try {
    self.postMessage({ type: "stage", id, purpose, stage: "Loading compiler" });
    const { default: CmajorCompiler } = await compilerModule;
    const compiler = new CmajorCompiler();
    if (!files.some(({ path }) => path === manifestPath)) throw new Error(`Missing manifest ${manifestPath}`);
    self.postMessage({ type: "stage", id, purpose, stage: "Preparing project" });
    const preparedFiles = await applySourceTransformer(files, manifestPath, resourceRoot);
    for (const { path, content } of preparedFiles) compiler.addSourceFile(path, content);
    self.postMessage({ type: "stage", id, purpose, stage: "Generating DSP" });
    const code = await compiler.createJavascriptCode();
    self.postMessage({ id, purpose, ok: true, code: purpose === "build" ? code : undefined, version: compiler.CmajorVersion });
  } catch (error) {
    self.postMessage({ id, purpose, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

async function applySourceTransformer(files, manifestPath, resourceRoot) {
  const manifestFile = files.find(({ path }) => path === manifestPath);
  const manifestText = typeof manifestFile.content === "string" ? manifestFile.content : new TextDecoder().decode(manifestFile.content);
  const manifest = JSON.parse(manifestText);
  if (!manifest.sourceTransformer) return files;
  if (!resourceRoot) throw new Error(`The source transformer ${manifest.sourceTransformer} has no browser resource root.`);

  const transformerURL = new URL(String(manifest.sourceTransformer).replace(/^\/+/, ""), resourceRoot);
  const transform = await createSourceTransformer(transformerURL);
  const sourcePaths = new Set((Array.isArray(manifest.source) ? manifest.source : [manifest.source]).filter(Boolean).map(String));
  return Promise.all(files.map(async (file) => sourcePaths.has(file.path)
    ? { ...file, content: await transform(file.path, typeof file.content === "string" ? file.content : new TextDecoder().decode(file.content)) }
    : file));
}

async function createSourceTransformer(url) {
  let ready;
  let resolveReady;
  const responses = new Map();
  ready = new Promise((resolve) => { resolveReady = resolve; });
  self.window = self;
  self.cmaj_sendMessageToServer = (message) => {
    if (message?.type === "ready") { resolveReady(); return; }
    const requestID = message?.message?.requestId;
    const response = responses.get(requestID);
    if (!response) return;
    responses.delete(requestID);
    if (message.type === "transformResponse") response.resolve(message.message.contents);
    else response.reject(new Error(`${response.filename}:${message.message?.line || 1}:${message.message?.column || 1}: error: ${message.message?.description || "Source transformation failed"}`));
  };

  const module = await import(/* @vite-ignore */ url.href);
  await module.default();
  await ready;
  let requestID = 0;
  return (filename, contents) => new Promise((resolve, reject) => {
    const id = ++requestID;
    responses.set(id, { resolve, reject, filename });
    self.currentView.deliverMessageFromServer({ type: "transformRequest", message: { requestId: id, filename, contents } });
  });
}
