import assert from "node:assert/strict";
import test from "node:test";
import { compileCacheKey } from "../src/compile-cache.js";

test("compile cache keys ignore file order", async () => {
  const files = [{ path: "main.cmajor", content: "processor Main {}" }, { path: "main.cmajorpatch", content: "{}" }];
  assert.equal(await compileCacheKey(files, "main.cmajorpatch"), await compileCacheKey([...files].reverse(), "main.cmajorpatch"));
});

test("compile cache keys change with project content and manifest selection", async () => {
  const files = [{ path: "main.cmajor", content: new TextEncoder().encode("processor Main {}") }];
  const original = await compileCacheKey(files, "main.cmajorpatch");
  assert.notEqual(original, await compileCacheKey([{ ...files[0], content: "processor Other {}" }], "main.cmajorpatch"));
  assert.notEqual(original, await compileCacheKey(files, "other.cmajorpatch"));
});
