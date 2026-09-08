#!/usr/bin/env node
// Exports Cmajor patches as WCLAP plug-ins from the command line, with the same pipeline the
// browser uses: compile with the bundled Cmajor compiler, link the DSP into the vendored
// wclap-cmajor-shell, package the bundle.
//
//   node scripts/export-wclap.mjs <patch folder>... [--out <dir>] [--examples] [--quiet]
//
//   --examples   also export every upstream example in src/generated/cmajor-example-catalog.json
//                (expects a sibling ../cmajor checkout) plus examples/simple-fm
//   --out        destination folder (default: ./wclap-exports)
//
// Requires `npm run sync:wclap-shell` to have vendored a shell into public/wclap-shell first.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = process.argv.slice(2);
const option = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const flag = (name) => args.includes(name);
const outDir = resolve(option("--out") ?? "wclap-exports");
const quiet = flag("--quiet");
const folders = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--out");

if (flag("--examples")) {
  const catalog = JSON.parse(readFileSync(join(root, "src/generated/cmajor-example-catalog.json"), "utf8"));
  folders.push(join(root, "examples/simple-fm"));
  for (const project of catalog) folders.push(resolve(root, "../cmajor/examples/patches", project.directory));
}
if (!folders.length) { console.error("usage: export-wclap.mjs <patch folder>... [--out <dir>] [--examples]"); process.exit(2); }

const shellDir = new URL("file://" + join(root, "public/wclap-shell/"));
if (!existsSync(new URL("manifest.json", shellDir))) { console.error("No vendored shell in public/wclap-shell: run `npm run sync:wclap-shell` first."); process.exit(1); }
const fetchLocal = async (url) => {
  const path = new URL(url);
  if (!existsSync(path)) return { ok: false, status: 404, url };
  const bytes = readFileSync(path);
  return { ok: true, status: 200, url, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), json: async () => JSON.parse(bytes.toString()) };
};

const { default: CmajorCompiler } = await import(join(root, "public/cmaj_api/cmaj-embedded-compiler-worker.js"));
const { exportWclap } = await import(join(root, "src/wclap-export/export-wclap.js"));
mkdirSync(outDir, { recursive: true });

const log = (...m) => { if (!quiet) console.log(...m); };
let failures = 0;
for (const folder of folders) {
  const dir = resolve(folder);
  const label = basename(dir);
  const started = performance.now();
  const stamp = () => `${((performance.now() - started) / 1000).toFixed(1)} s`;
  try {
    const files = [];
    // Skip OS and VCS clutter so the bundle matches what the browser export contains.
    const walk = (d) => { for (const name of readdirSync(d)) { if (name === ".DS_Store" || name === ".git" || name === "Thumbs.db") continue; const p = join(d, name); if (statSync(p).isDirectory()) walk(p); else files.push({ path: relative(dir, p).split("\\").join("/"), content: readFileSync(p) }); } };
    walk(dir);
    const manifestPath = files.find((f) => f.path.endsWith(".cmajorpatch") && !f.path.includes("/"))?.path
      ?? files.find((f) => f.path.endsWith(".cmajorpatch"))?.path;
    if (!manifestPath) throw new Error("no .cmajorpatch in the folder");
    const compiler = new CmajorCompiler();
    for (const f of files) compiler.addSourceFile(f.path, f.content);
    const code = await compiler.createJavascriptCode();
    log(`  ${label}: compiled in ${stamp()}`);
    const stages = [];
    const { archive, fileName, stats } = await exportWclap({
      code, compilerVersion: compiler.CmajorVersion, manifestPath, files, shellURL: shellDir, fetch: fetchLocal,
      onStage: (stage) => stages.push(`${stage} @ ${stamp()}`),
    });
    writeFileSync(join(outDir, fileName), archive);
    log(`  ${label}: ${stages.join(", ")}`);
    console.log(`OK    ${label.padEnd(24)} ${fileName}  ${(archive.length / 1024).toFixed(0)} KiB, ${stats.dspFunctions} DSP functions, ${stamp()}`);
  } catch (error) {
    failures++;
    console.log(`FAIL  ${label.padEnd(24)} ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
  }
}
console.log(`\n${folders.length - failures}/${folders.length} exported to ${outDir}`);
process.exit(failures ? 1 : 0);
