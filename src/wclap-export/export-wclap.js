// "Export as WCLAP": links a compiled patch into the vendored wclap-cmajor-shell and packages
// the result, entirely in the browser, as the `.wclap.tar.gz` archive WCLAP hosts install.
//
// Bundle layout (what the shell's build makes, plus the patch under ui/patch/):
//   module.wasm            the shell with this patch's DSP linked in
//   memory.json            the shell's memory hint
//   ui/…                   the shell's webview page and Cmajor's cmaj_api
//   ui/patch/<files>       the patch: manifest, sources, GUI, worker, resources
//   LICENSE.txt, THIRD_PARTY_NOTICES.md, THIRD_PARTY_LICENSES/

import { encode as encodeCBOR } from "./cbor.js";
import { extractRuntimeInfo } from "./runtime-info.js";
import { linkCmajorIntoShell } from "./wasm-linker.js";
import { createTar, gzip } from "./tar.js";

const PATCH_PREFIX = "ui/patch/";

/**
 * @param {object} options
 * @param {string} options.code - the compiler's generated JavaScript class
 * @param {string} options.compilerVersion
 * @param {string} options.manifestPath - path of the .cmajorpatch within the project
 * @param {{ path: string, content: string | Uint8Array | ArrayBuffer }[]} options.files - every project file
 * @param {string | URL} [options.shellURL] - where the vendored shell bundle is served from
 * @param {(stage: string) => void} [options.onStage]
 * @param {(url: string) => Promise<Response>} [options.fetch]
 * @returns {Promise<{ archive: Uint8Array, fileName: string, name: string, stats: object }>}
 */
export async function exportWclap({ code, compilerVersion, manifestPath, files, shellURL, onStage = () => {}, fetch: fetchImpl = globalThis.fetch }) {
  const manifestFile = files.find((f) => f.path === manifestPath);
  if (!manifestFile) throw new Error(`The project has no ${manifestPath}`);
  const manifest = JSON.parse(text(manifestFile.content));
  const base = new URL(shellURL ?? "wclap-shell/", typeof document !== "undefined" ? document.baseURI : "file:///");

  onStage("Loading the WCLAP shell");
  const shellManifest = await (await ok(fetchImpl(new URL("manifest.json", base).href))).json();
  const shellFiles = await Promise.all(shellManifest.files.map(async (path) => ({ path, data: new Uint8Array(await (await ok(fetchImpl(new URL(path, base).href))).arrayBuffer()) })));
  const shellModule = shellFiles.find((f) => f.path === "module.wasm");
  if (!shellModule) throw new Error("The shell bundle has no module.wasm");

  onStage("Reading the patch's interface");
  const { wasm, metadata, slots } = await extractRuntimeInfo(code, { manifest, manifestPath, compilerVersion });
  metadata.shellVersion = shellManifest.version;

  onStage("Linking the DSP into the shell");
  const { bytes: linked, stats } = linkCmajorIntoShell(shellModule.data, wasm, { metadata: encodeCBOR(metadata), slots });

  onStage("Packaging the plug-in");
  const entries = [
    { path: "module.wasm", data: linked, mode: 0o755 },
    ...shellFiles.filter((f) => f.path !== "module.wasm").map((f) => ({ path: f.path, data: f.data })),
    ...files.filter((f) => isSafePath(f.path)).map((f) => ({ path: PATCH_PREFIX + f.path, data: bytes(f.content) })),
  ];
  const archive = await gzip(createTar(entries));
  const name = String(manifest.name || manifestPath.replace(/\.cmajorpatch$/i, "").split("/").at(-1));
  const fileName = `${name.replace(/[\\/:*?"<>|]+/g, "_").trim() || "Cmajor patch"}.wclap.tar.gz`;
  return { archive, fileName, name, stats: { ...stats, files: entries.length, archiveBytes: archive.length } };
}

async function ok(responsePromise) {
  const response = await responsePromise;
  if (!response.ok) throw new Error(`Could not load ${response.url} (${response.status})`);
  return response;
}

function text(content) { return typeof content === "string" ? content : new TextDecoder().decode(bytes(content)); }
function bytes(content) {
  if (content instanceof Uint8Array) return content;
  if (content instanceof ArrayBuffer) return new Uint8Array(content);
  if (ArrayBuffer.isView(content)) return new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
  return new TextEncoder().encode(String(content));
}
function isSafePath(path) {
  const parts = String(path).split("/");
  return path.length <= 400 && !path.startsWith("/") && parts.every((p) => p && p !== "." && p !== "..");
}
