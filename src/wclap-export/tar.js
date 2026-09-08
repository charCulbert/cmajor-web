// A minimal USTAR writer plus gzip, enough to produce the `.wclap.tar.gz` archives WCLAP
// hosts install (the same layout clap-wrapper's `cmake -E tar cfz --format=gnutar` makes).

const BLOCK = 512;
const FIXED_MTIME = Date.UTC(2026, 0, 1) / 1000;
const encoder = new TextEncoder();

/**
 * @param {{ path: string, data: Uint8Array, mode?: number, mtime?: number }[]} entries
 * @returns {Uint8Array} the uncompressed archive
 */
export function createTar(entries) {
  const parts = [];
  // A fixed timestamp keeps archives reproducible: the same patch and shell give the same bytes.
  const mtime = FIXED_MTIME;
  const directories = new Set();
  for (const entry of entries) {
    // Emit each parent directory once; some extractors need them to exist.
    const segments = entry.path.split("/");
    for (let i = 1; i < segments.length; i++) {
      const dir = segments.slice(0, i).join("/") + "/";
      if (!directories.has(dir)) { directories.add(dir); parts.push(header(dir, 0, 0o755, mtime, "5")); }
    }
    parts.push(header(entry.path, entry.data.length, entry.mode ?? 0o644, entry.mtime ?? mtime, "0"), entry.data, padding(entry.data.length));
  }
  parts.push(new Uint8Array(BLOCK * 2));
  const size = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const p of parts) { out.set(p, offset); offset += p.length; }
  return out;
}

function padding(length) { return new Uint8Array((BLOCK - (length % BLOCK)) % BLOCK); }

function header(path, size, mode, mtime, type) {
  const bytes = encoder.encode(path);
  let name = bytes, prefix = new Uint8Array(0);
  if (bytes.length > 100) {
    // USTAR splits long paths at a slash into prefix (155) + name (100).
    let split = -1;
    for (let i = 0; i < bytes.length; i++) if (bytes[i] === 0x2f && i < 155 && bytes.length - i - 1 <= 100) split = i;
    if (split < 0) throw new Error(`Path too long for the archive: ${path}`);
    prefix = bytes.subarray(0, split); name = bytes.subarray(split + 1);
  }
  const h = new Uint8Array(BLOCK);
  h.set(name, 0);
  writeOctal(h, 100, 8, mode);
  writeOctal(h, 108, 8, 0);
  writeOctal(h, 116, 8, 0);
  writeOctal(h, 124, 12, size);
  writeOctal(h, 136, 12, mtime);
  h.fill(0x20, 148, 156);              // checksum placeholder
  h[156] = type.charCodeAt(0);
  h.set(encoder.encode("ustar"), 257); h[262] = 0;
  h.set(encoder.encode("00"), 263);
  h.set(prefix, 345);
  let sum = 0; for (const b of h) sum += b;
  const check = encoder.encode(sum.toString(8).padStart(6, "0") + "\0 ");
  h.set(check, 148);
  return h;
}

function writeOctal(h, offset, length, value) {
  h.set(encoder.encode(value.toString(8).padStart(length - 1, "0")), offset);
  h[offset + length - 1] = 0;
}

/** gzip via the platform's CompressionStream (browsers and Node 18+). */
export async function gzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
