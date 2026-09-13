import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exportWclap } from "../wclap-export/export-wclap.js";

const defaultShellURL = new URL("../../public/wclap-shell/", import.meta.url);
const compilerModuleURL = new URL("../../public/cmaj_api/cmaj-embedded-compiler-worker.js", import.meta.url);

/** Reads a patch manifest or folder using the same exclusions as the browser's folder importer. */
export function readPatchFolder(input) {
  const requestedPath = resolve(input);
  if (!existsSync(requestedPath)) throw new Error(`Patch not found: ${input}`);
  const requestedStat = statSync(requestedPath);
  if (!requestedStat.isDirectory() && (!requestedStat.isFile() || !requestedPath.endsWith(".cmajorpatch"))) {
    throw new Error(`Expected a .cmajorpatch file or patch folder: ${input}`);
  }
  const directory = requestedStat.isDirectory() ? requestedPath : dirname(requestedPath);
  const requestedManifest = requestedStat.isFile() ? basename(requestedPath) : null;
  const files = [];
  const walk = (current) => {
    for (const name of readdirSync(current)) {
      if (name === ".DS_Store" || name === ".git" || name === "Thumbs.db") continue;
      const path = join(current, name);
      if (statSync(path).isDirectory()) walk(path);
      else files.push({ path: relative(directory, path).split("\\").join("/"), content: readFileSync(path) });
    }
  };
  walk(directory);
  const manifestPath = requestedManifest
    ?? files.find((file) => file.path.endsWith(".cmajorpatch") && !file.path.includes("/"))?.path
    ?? files.find((file) => file.path.endsWith(".cmajorpatch"))?.path;
  if (!manifestPath) throw new Error(`No .cmajorpatch manifest found in ${input}`);
  return { directory, files, manifestPath };
}

/** File-backed fetch adapter used by the shared browser/Node WCLAP packager. */
export async function fetchLocal(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== "file:") return { ok: false, status: 400, url: parsed.href };
  const path = fileURLToPath(parsed);
  if (!existsSync(path)) return { ok: false, status: 404, url: parsed.href };
  const data = readFileSync(path);
  return {
    ok: true,
    status: 200,
    url: parsed.href,
    arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
    json: async () => JSON.parse(data.toString()),
  };
}

/**
 * Compiles one patch folder with the repository's pinned embedded compiler and writes a WCLAP.
 */
export async function exportWclapFolder(folder, { outDir = ".", shellURL = defaultShellURL, onStage = () => {} } = {}) {
  const started = performance.now();
  onStage("Reading the patch");
  const { directory, files, manifestPath } = readPatchFolder(folder);
  const shellManifest = new URL("manifest.json", shellURL);
  if (shellManifest.protocol === "file:" && !existsSync(fileURLToPath(shellManifest))) {
    throw new Error(`No vendored WCLAP shell at ${fileURLToPath(shellURL)}; run npm run sync:wclap-shell first`);
  }

  onStage("Loading the embedded compiler");
  const { default: CmajorCompiler } = await import(compilerModuleURL.href);
  const compiler = new CmajorCompiler();
  compiler.manifestPath = manifestPath;
  const manifestFile = files.find((file) => file.path === manifestPath);
  for (const file of [manifestFile, ...files.filter((candidate) => candidate !== manifestFile)]) {
    compiler.addSourceFile(file.path, file.content);
  }
  onStage("Compiling the patch");
  const compileStarted = performance.now();
  const code = await compiler.createJavascriptCode();
  const compileMs = performance.now() - compileStarted;

  const exportStarted = performance.now();
  const result = await exportWclap({
    code,
    compilerVersion: compiler.CmajorVersion,
    manifestPath,
    files,
    shellURL,
    fetch: fetchLocal,
    onStage,
  });
  const exportMs = performance.now() - exportStarted;
  const destination = resolve(outDir);
  mkdirSync(destination, { recursive: true });
  const outputPath = join(destination, result.fileName);
  writeFileSync(outputPath, result.archive);

  return {
    ok: true,
    patch: basename(directory),
    manifestPath,
    outputPath,
    fileName: result.fileName,
    compilerVersion: compiler.CmajorVersion,
    archiveBytes: result.archive.length,
    stats: result.stats,
    timings: { compileMs, exportMs, totalMs: performance.now() - started },
  };
}
