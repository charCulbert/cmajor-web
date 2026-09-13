import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPatchFolder } from "../src/node/export-wclap.js";
import { parseArgs, run } from "../src/node/wclap-cli.js";

test("CLI parses export commands and agent-friendly options", () => {
  assert.deepEqual(parseArgs(["export", "one", "two", "--out=dist", "--json"]), {
    folders: ["one", "two"], outDir: "dist", json: true, quiet: false, examples: false, help: false, version: false,
  });
  assert.equal(parseArgs(["export-wclap", "patch", "-q", "-o", "build"]).quiet, true);
  assert.throws(() => parseArgs(["inspect", "patch"]), /Unknown command/);
  assert.throws(() => parseArgs(["export", "patch", "--wat"]), /Unknown option/);
});

test("CLI help and usage errors do not compile", async () => {
  const output = [], errors = [];
  assert.equal(await run(["--help"], { stdout: (line) => output.push(line), stderr: (line) => errors.push(line) }), 0);
  assert.match(output.join("\n"), /cmajor-web export-wclap/);
  assert.equal(await run(["export"], { stdout: (line) => output.push(line), stderr: (line) => errors.push(line) }), 2);
  assert.match(errors.join("\n"), /at least one \.cmajorpatch file or patch folder/);
});

test("patch folder reader finds a manifest and ignores filesystem clutter", () => {
  const folder = mkdtempSync(join(tmpdir(), "cmajor-web-cli-"));
  writeFileSync(join(folder, "Synth.cmajorpatch"), "{}");
  writeFileSync(join(folder, "Synth.cmajor"), "processor Synth {}");
  writeFileSync(join(folder, ".DS_Store"), "clutter");
  const project = readPatchFolder(folder);
  assert.equal(project.manifestPath, "Synth.cmajorpatch");
  assert.deepEqual(project.files.map(({ path }) => path).sort(), ["Synth.cmajor", "Synth.cmajorpatch"]);
  assert.equal(readPatchFolder(join(folder, "Synth.cmajorpatch")).manifestPath, "Synth.cmajorpatch");
});
