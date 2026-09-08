import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createTar, gzip } from "../src/wclap-export/tar.js";
import { exportWclap } from "../src/wclap-export/export-wclap.js";
import { extractRuntimeInfo } from "../src/wclap-export/runtime-info.js";

const shellDir = new URL("../public/wclap-shell/", import.meta.url);
const hasShell = existsSync(new URL("module.wasm", shellDir));

// Serves the vendored shell the way the browser fetches it.
const fetchLocal = async (url) => {
  const path = new URL(url);
  if (!existsSync(path)) return { ok: false, status: 404, url };
  const bytes = readFileSync(path);
  return { ok: true, status: 200, url, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), json: async () => JSON.parse(bytes.toString()) };
};

function projectFiles(dir) {
  const files = [];
  const walk = (d) => { for (const name of readdirSync(d)) { const p = join(d, name); if (statSync(p).isDirectory()) walk(p); else files.push({ path: relative(dir, p), content: readFileSync(p) }); } };
  walk(dir);
  return files;
}

async function compileExample(files) {
  const { default: CmajorCompiler } = await import("../public/cmaj_api/cmaj-embedded-compiler-worker.js");
  const compiler = new CmajorCompiler();
  for (const f of files) compiler.addSourceFile(f.path, f.content);
  return { code: await compiler.createJavascriptCode(), version: compiler.CmajorVersion };
}

test("tar archives extract with the expected layout", async () => {
  const bytes = createTar([
    { path: "module.wasm", data: new Uint8Array([0, 97, 115, 109]) },
    { path: "ui/patch/" + "deep/".repeat(30) + "file.txt", data: new TextEncoder().encode("hello") },
  ]);
  const dir = mkdtempSync(join(tmpdir(), "wclap-tar-"));
  writeFileSync(join(dir, "a.tar.gz"), await gzip(bytes));
  const listing = execFileSync("tar", ["tzf", join(dir, "a.tar.gz")], { encoding: "utf8" });
  assert.match(listing, /^module\.wasm$/m);
  assert.match(listing, /deep\/file\.txt$/m);
  execFileSync("tar", ["xzf", join(dir, "a.tar.gz"), "-C", dir]);
  assert.equal(readFileSync(join(dir, "ui/patch/" + "deep/".repeat(30) + "file.txt"), "utf8"), "hello");
});

test("runtime info recovers the simple FM synth's interface", { timeout: 120000 }, async () => {
  const files = projectFiles(new URL("../examples/simple-fm/", import.meta.url).pathname);
  const { code, version } = await compileExample(files);
  const manifest = JSON.parse(files.find((f) => f.path.endsWith(".cmajorpatch")).content.toString());
  const { wasm, metadata, slots } = await extractRuntimeInfo(code, { manifest, manifestPath: "SimpleFMSynth.cmajorpatch", compilerVersion: version });
  assert.ok(wasm.length > 1000);
  assert.equal(metadata.format, "wclap-cmajor-shell/1");
  assert.ok(metadata.stateSize > 0 && metadata.ioSize > 0);
  const midi = metadata.inputs.find((i) => i.id === "midiIn");
  assert.equal(midi.events[0].wasmArg, "ptr");
  assert.deepEqual(midi.events[0].layout, [{ path: ".message", kind: "int32", offset: 0 }]);
  const level = metadata.inputs.find((i) => i.id === "level");
  assert.equal(level.events[0].wasmArg, "f32");
  assert.equal(level.purpose, "parameter");
  const out = metadata.outputs.find((o) => o.id === "out");
  assert.equal(out.kind, "stream");
  assert.ok(slots.includes("_sendEvent_midiIn"));
});

test("exports a WCLAP archive for the simple FM synth", { skip: !hasShell && "public/wclap-shell is not vendored", timeout: 120000 }, async () => {
  const files = projectFiles(new URL("../examples/simple-fm/", import.meta.url).pathname);
  const { code, version } = await compileExample(files);
  const stages = [];
  const { archive, fileName, stats } = await exportWclap({ code, compilerVersion: version, manifestPath: "SimpleFMSynth.cmajorpatch", files, shellURL: shellDir, fetch: fetchLocal, onStage: (s) => stages.push(s) });
  assert.equal(fileName, "Simple FM Synth.wclap.tar.gz");
  assert.ok(stats.dspFunctions > 0 && stats.tableSlots > 0);
  assert.ok(stages.length >= 4);
  const dir = mkdtempSync(join(tmpdir(), "wclap-export-"));
  writeFileSync(join(dir, fileName), archive);
  const listing = execFileSync("tar", ["tzf", join(dir, fileName)], { encoding: "utf8" }).split("\n");
  for (const expected of ["module.wasm", "memory.json", "ui/index.html", "ui/cmaj_api/cmaj-patch-view.js", "ui/patch/SimpleFMSynth.cmajorpatch", "ui/patch/SimpleFMSynthView.js"])
    assert.ok(listing.includes(expected), `${expected} missing from the archive`);
  execFileSync("tar", ["xzf", join(dir, fileName), "-C", dir]);
  assert.ok(WebAssembly.validate(readFileSync(join(dir, "module.wasm"))));
});
