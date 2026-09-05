import assert from "node:assert/strict";
import test from "node:test";
import { decodeProject, encodeProject, MAX_FRAGMENT_LENGTH, MAX_SOURCE_BYTES } from "../src/share.js";

function base64url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

async function rawPayload(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const compressed = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
  return base64url(await new Response(compressed).arrayBuffer());
}

test("share payload round-trips Unicode", async () => {
  const source = "processor Ångström {} // 🎵 漢字";
  const encoded = await encodeProject({ source, name: "Øresund" });
  assert.deepEqual(await decodeProject(encoded), { source, name: "Øresund" });
});

test("share payload round-trips additional source files", async () => {
  const project = {
    source: "processor Main [[ main ]] {}",
    files: [{ path: "dsp/Voices.cmajor", content: "namespace Vøices { /* 🎵 */ }" }],
    manifestPath: "patches/Original.cmajorpatch",
    manifestDoc: "{\n  \"source\": [\"main.cmajor\", \"dsp/Voices.cmajor\"]\n}",
    folders: ["empty", "dsp"],
    resources: [{ path: "ui/custom view.js", content: "export default () => document.createElement('div');" }],
    name: "Multi-file",
  };
  const { resources, ...sharedProject } = project;
  assert.deepEqual(await decodeProject(await encodeProject(project)), { ...sharedProject, assetFiles: resources });
});

test("malformed payloads fail clearly", async () => {
  await assert.rejects(() => decodeProject("%%%"), /malformed or damaged/);
});

test("unsupported versions are rejected", async () => {
  const payload = await rawPayload({ version: 2, source: "hello" });
  await assert.rejects(() => decodeProject(payload), /Unsupported share payload version: 2/);
});

test("unsafe additional source paths are rejected", async () => {
  await assert.rejects(() => encodeProject({ source: "hello", files: [{ path: "../secret.cmajor", content: "" }] }), /invalid source file/);
});

test("oversized fragments and decompressed payloads are rejected", async () => {
  await assert.rejects(() => decodeProject("a".repeat(MAX_FRAGMENT_LENGTH + 1)), /too large/);
  const bomb = await rawPayload({ version: 1, source: "x".repeat(MAX_SOURCE_BYTES + 1) });
  await assert.rejects(() => decodeProject(bomb), /too large/);
});
