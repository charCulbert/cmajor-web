export const SHARE_VERSION = 1;
export const MAX_SOURCE_BYTES = 256 * 1024;
export const MAX_FRAGMENT_LENGTH = 64 * 1024;

function validateFiles(files) {
  if (files === undefined) return [];
  if (!Array.isArray(files)) throw new Error("The share payload has an invalid source file list.");
  for (const file of files) {
    if (!file || typeof file.path !== "string" || typeof file.content !== "string"
        || !file.path.endsWith(".cmajor") || !validRelativePath(file.path)) {
      throw new Error("The share payload contains an invalid source file.");
    }
  }
  return files;
}

function validRelativePath(path, suffix = "") {
  if (typeof path !== "string" || (suffix && !path.endsWith(suffix)) || path.length > 512
      || path.startsWith("/") || /[\\\u0000-\u001f\u007f]/.test(path)) return false;
  return path.split("/").every((part) => part && part !== "." && part !== "..");
}

function validateFolders(folders) {
  if (folders === undefined) return [];
  if (!Array.isArray(folders) || folders.some((path) => !validRelativePath(path))) {
    throw new Error("The share payload contains an invalid project folder.");
  }
  return folders;
}

function validateResources(resources) {
  if (resources === undefined) return [];
  if (!Array.isArray(resources) || resources.some((file) => !file || !validRelativePath(file.path) || typeof file.content !== "string")) {
    throw new Error("The share payload contains an invalid text resource.");
  }
  return resources;
}

function toBase64Url(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64Url(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("The share payload is not valid base64url.");
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function transform(bytes, format, streamType, sizeLimit = Infinity) {
  const stream = new Blob([bytes]).stream().pipeThrough(new streamType(format));
  const reader = stream.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > sizeLimit) {
      await reader.cancel();
      throw new Error("The decompressed share payload is too large.");
    }
    chunks.push(value);
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

export async function encodeProject(project) {
  const files = validateFiles(project.files);
  const resources = validateResources(project.resources);
  validateFolders(project.folders);
  if (project.manifestPath !== undefined && !validRelativePath(project.manifestPath, ".cmajorpatch")) {
    throw new Error("The share payload contains an invalid manifest path.");
  }
  if (project.manifestDoc !== undefined && typeof project.manifestDoc !== "string") {
    throw new Error("The share payload contains an invalid manifest.");
  }
  const raw = new TextEncoder().encode(JSON.stringify({ version: SHARE_VERSION, ...project }));
  const sourceSize = [project.source, project.manifestDoc || "", ...files.map(({ content }) => content), ...resources.map(({ content }) => content)]
    .reduce((size, source) => size + new TextEncoder().encode(source).length, 0);
  if (sourceSize > MAX_SOURCE_BYTES) {
    throw new Error("This project's sources are too large for a share link. Download them as files instead.");
  }
  const encoded = toBase64Url(await transform(raw, "gzip", CompressionStream));
  if (encoded.length > MAX_FRAGMENT_LENGTH) {
    throw new Error("This project is too large for a comfortable share link. Download it as a file instead.");
  }
  return encoded;
}

export async function decodeProject(encoded) {
  if (encoded.length > MAX_FRAGMENT_LENGTH) throw new Error("The share link is too large.");
  let decoded;
  try {
    decoded = await transform(fromBase64Url(encoded), "gzip", DecompressionStream, MAX_SOURCE_BYTES + 16384);
  } catch (error) {
    if (error instanceof Error && error.message.includes("decompressed share payload")) throw error;
    throw new Error("The share link is malformed or damaged.");
  }
  let project;
  try {
    project = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decoded));
  } catch {
    throw new Error("The share link does not contain a valid UTF-8 project.");
  }
  if (project.version !== SHARE_VERSION) throw new Error(`Unsupported share payload version: ${project.version ?? "missing"}.`);
  if (typeof project.source !== "string") throw new Error("The share payload has no source file.");
  const files = validateFiles(project.files);
  const resources = validateResources(project.resources);
  const folders = validateFolders(project.folders);
  if (project.manifestPath !== undefined && !validRelativePath(project.manifestPath, ".cmajorpatch")) {
    throw new Error("The share payload contains an invalid manifest path.");
  }
  if (project.manifestDoc !== undefined && typeof project.manifestDoc !== "string") {
    throw new Error("The share payload contains an invalid manifest.");
  }
  const sourceSize = [project.source, project.manifestDoc || "", ...files.map(({ content }) => content), ...resources.map(({ content }) => content)]
    .reduce((size, source) => size + new TextEncoder().encode(source).length, 0);
  if (sourceSize > MAX_SOURCE_BYTES) throw new Error("The shared project sources are too large.");
  const result = { source: project.source, name: typeof project.name === "string" ? project.name : "Shared patch" };
  if (project.files !== undefined) result.files = files;
  if (project.manifestPath !== undefined) result.manifestPath = project.manifestPath;
  if (project.manifestDoc !== undefined) result.manifestDoc = project.manifestDoc;
  if (project.folders !== undefined) result.folders = folders;
  if (project.resources !== undefined) result.assetFiles = resources;
  return result;
}
