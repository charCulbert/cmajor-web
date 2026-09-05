const GITHUB_HOSTS = new Set(["github.com", "www.github.com"]);

export const MAX_GITHUB_FILES = 2000;

function validName(value) {
  return typeof value === "string" && /^[A-Za-z0-9_.-]+$/.test(value) && value !== "." && value !== "..";
}

export function validProjectPath(path, { allowEmpty = true } = {}) {
  if (typeof path !== "string" || path.length > 1024 || path.startsWith("/") || path.endsWith("/")
      || /[\\\u0000-\u001f\u007f]/.test(path)) return false;
  if (!path) return allowEmpty;
  return path.split("/").every((part) => part && part !== "." && part !== "..");
}

export function parseGitHubProject(value) {
  const input = String(value || "").trim();
  let owner;
  let repo;
  let ref = "";
  let path = "";
  let manifest = "";

  if (/^[^/:\s]+\/[^/:\s]+$/.test(input)) {
    [owner, repo] = input.split("/");
  } else {
    let url;
    try { url = new URL(input); } catch { throw new Error("Enter a GitHub repository URL or owner/repository."); }
    if (!GITHUB_HOSTS.has(url.hostname.toLowerCase())) throw new Error("Only github.com repository URLs are supported.");
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    [owner, repo] = parts;
    if (parts[2] === "tree" && parts[3]) {
      ref = parts[3];
      path = parts.slice(4).join("/");
    } else if (parts[2] === "blob" && parts[3]) {
      ref = parts[3];
      manifest = parts.slice(4).join("/");
      path = manifest.split("/").slice(0, -1).join("/");
    } else if (parts.length > 2) {
      throw new Error("Use a repository, tree, or .cmajorpatch file URL.");
    }
  }

  repo = repo?.replace(/\.git$/i, "");
  if (!validName(owner) || !validName(repo)) throw new Error("The GitHub owner or repository name is invalid.");
  if (path && !validProjectPath(path, { allowEmpty: false })) throw new Error("The GitHub folder path is invalid.");
  if (manifest && (!validProjectPath(manifest, { allowEmpty: false }) || !manifest.endsWith(".cmajorpatch"))) {
    throw new Error("The GitHub manifest path is invalid.");
  }
  return { owner, repo, ref, path, manifest };
}

export function githubProjectFromFragment(fragment) {
  const params = fragment instanceof URLSearchParams ? fragment : new URLSearchParams(String(fragment).replace(/^#/, ""));
  const repository = params.get("github");
  if (!repository) return null;
  const result = parseGitHubProject(repository);
  const ref = params.get("ref") || result.ref;
  const path = params.get("path") || result.path;
  const manifest = params.get("manifest") || result.manifest;
  if (ref.length > 255 || /[\u0000-\u001f\u007f]/.test(ref)) throw new Error("The GitHub revision is invalid.");
  if (path && !validProjectPath(path, { allowEmpty: false })) throw new Error("The GitHub folder path is invalid.");
  if (manifest && (!validProjectPath(manifest, { allowEmpty: false }) || !manifest.endsWith(".cmajorpatch"))) {
    throw new Error("The GitHub manifest path is invalid.");
  }
  return { owner: result.owner, repo: result.repo, ref, path, manifest };
}

export function githubProjectFragment(project) {
  const params = new URLSearchParams({ github: `${project.owner}/${project.repo}`, ref: project.sha || project.ref });
  if (project.path) params.set("path", project.path);
  if (project.manifest) params.set("manifest", project.manifest);
  return params.toString();
}

async function githubJSON(url, fetchImpl) {
  const response = await fetchImpl(url, { headers: { Accept: "application/vnd.github+json" } });
  if (!response.ok) {
    if (response.status === 404) throw new Error("GitHub repository, revision, or folder was not found. Only public repositories can be opened.");
    if (response.status === 403) throw new Error("GitHub's anonymous API limit was reached. Try again later.");
    throw new Error(`GitHub request failed (${response.status}).`);
  }
  return response.json();
}

export async function discoverGitHubProject(project, { fetchImpl = fetch } = {}) {
  const apiRoot = `https://api.github.com/repos/${encodeURIComponent(project.owner)}/${encodeURIComponent(project.repo)}`;
  const repository = await githubJSON(apiRoot, fetchImpl);
  const requestedRef = project.ref || repository.default_branch;
  const commit = await githubJSON(`${apiRoot}/commits/${encodeURIComponent(requestedRef)}`, fetchImpl);
  const tree = await githubJSON(`${apiRoot}/git/trees/${encodeURIComponent(commit.sha)}?recursive=1`, fetchImpl);
  if (tree.truncated) throw new Error("This GitHub repository is too large to enumerate safely.");
  const prefix = project.path ? `${project.path}/` : "";
  const blobs = tree.tree.filter((entry) => entry.type === "blob" && entry.path.startsWith(prefix));
  const manifests = blobs.map(({ path }) => path).filter((path) => path.endsWith(".cmajorpatch"));
  if (!manifests.length) throw new Error(project.path ? "That GitHub folder contains no .cmajorpatch manifests." : "That repository contains no .cmajorpatch manifests.");
  if (project.manifest && !manifests.includes(project.manifest)) throw new Error(`GitHub manifest ${project.manifest} was not found in the selected folder.`);
  return { ...project, ref: requestedRef, sha: commit.sha, blobs, manifests };
}

export async function downloadGitHubPatch(discovery, manifest, { fetchImpl = fetch, maxBytes } = {}) {
  if (!discovery.manifests.includes(manifest)) throw new Error("Choose a manifest from the discovered GitHub project.");
  const folder = manifest.split("/").slice(0, -1).join("/");
  const prefix = folder ? `${folder}/` : "";
  const files = discovery.blobs.filter(({ path }) => path.startsWith(prefix));
  if (files.length > MAX_GITHUB_FILES) throw new Error(`The selected patch contains more than ${MAX_GITHUB_FILES} files.`);
  const totalBytes = files.reduce((total, file) => total + (Number(file.size) || 0), 0);
  if (Number.isFinite(maxBytes) && totalBytes > maxBytes) throw new Error("The selected patch exceeds the 100 MiB in-browser limit.");

  const root = `https://raw.githubusercontent.com/${encodeURIComponent(discovery.owner)}/${encodeURIComponent(discovery.repo)}/${encodeURIComponent(discovery.sha)}/`;
  return Promise.all(files.map(async ({ path }) => {
    const relativePath = path.slice(prefix.length);
    const url = root + path.split("/").map(encodeURIComponent).join("/");
    const response = await fetchImpl(url);
    if (!response.ok) throw new Error(`Could not download ${path} (${response.status}).`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { path: relativePath, bytes };
  }));
}
