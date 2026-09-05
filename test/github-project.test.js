import assert from "node:assert/strict";
import test from "node:test";
import {
  discoverGitHubProject,
  downloadGitHubPatch,
  githubProjectFragment,
  githubProjectFromFragment,
  parseGitHubProject,
} from "../src/github-project.js";

test("GitHub repository, tree, and manifest URLs parse", () => {
  assert.deepEqual(parseGitHubProject("cmajor-lang/cmajor"), { owner: "cmajor-lang", repo: "cmajor", ref: "", path: "", manifest: "" });
  assert.deepEqual(parseGitHubProject("https://github.com/cmajor-lang/cmajor/tree/main/examples/patches/808"), {
    owner: "cmajor-lang", repo: "cmajor", ref: "main", path: "examples/patches/808", manifest: "",
  });
  assert.deepEqual(parseGitHubProject("https://github.com/cmajor-lang/cmajor/blob/main/examples/patches/808/808.cmajorpatch"), {
    owner: "cmajor-lang", repo: "cmajor", ref: "main", path: "examples/patches/808", manifest: "examples/patches/808/808.cmajorpatch",
  });
});

test("canonical GitHub fragments preserve Unicode paths and immutable selection", () => {
  const project = { owner: "someone", repo: "sounds", sha: "abc123", path: "patches/日本語", manifest: "patches/日本語/Synth.cmajorpatch" };
  assert.deepEqual(githubProjectFromFragment(githubProjectFragment(project)), {
    owner: project.owner, repo: project.repo, ref: project.sha, path: project.path, manifest: project.manifest,
  });
});

test("unsafe and non-GitHub locations are rejected", () => {
  assert.throws(() => parseGitHubProject("https://example.com/a/b"), /Only github.com/);
  assert.throws(() => githubProjectFromFragment("github=a%2Fb&path=../secret"), /folder path is invalid/);
});

test("discovery resolves a ref and returns every manifest under the selected folder", async () => {
  const replies = [
    { default_branch: "main" },
    { sha: "deadbeef" },
    { truncated: false, tree: [
      { type: "blob", path: "patches/A/A.cmajorpatch", size: 100 },
      { type: "blob", path: "patches/B/B.cmajorpatch", size: 100 },
      { type: "blob", path: "README.md", size: 20 },
    ] },
  ];
  const fetchImpl = async () => ({ ok: true, json: async () => replies.shift() });
  const result = await discoverGitHubProject(parseGitHubProject("a/b"), { fetchImpl });
  assert.equal(result.sha, "deadbeef");
  assert.deepEqual(result.manifests, ["patches/A/A.cmajorpatch", "patches/B/B.cmajorpatch"]);
});

test("downloading a selected patch does not merge sibling manifest folders", async () => {
  const discovery = {
    owner: "a", repo: "b", sha: "deadbeef",
    manifests: ["patches/A/A.cmajorpatch", "patches/B/B.cmajorpatch"],
    blobs: [
      { type: "blob", path: "patches/A/A.cmajorpatch", size: 2 },
      { type: "blob", path: "patches/A/A.cmajor", size: 3 },
      { type: "blob", path: "patches/B/B.cmajorpatch", size: 2 },
    ],
  };
  const fetchImpl = async (url) => ({ ok: true, arrayBuffer: async () => new TextEncoder().encode(url.endsWith("cmajorpatch") ? "{}" : "dsp").buffer });
  const entries = await downloadGitHubPatch(discovery, "patches/A/A.cmajorpatch", { fetchImpl, maxBytes: 100 });
  assert.deepEqual(entries.map(({ path }) => path), ["A.cmajorpatch", "A.cmajor"]);
});
