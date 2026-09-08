// Minimal CBOR (RFC 8949) codec for plug-in <-> UI messages: integers, floats, booleans,
// null, strings, byte strings (Uint8Array), arrays and string-keyed objects.
export function encode(value) {
  const chunks = [];
  let size = 0;
  const push = (bytes) => { chunks.push(bytes); size += bytes.length; };
  const head = (major, n) => {
    const m = major << 5;
    if (n < 24) push(Uint8Array.of(m | n));
    else if (n < 0x100) push(Uint8Array.of(m | 24, n));
    else if (n < 0x10000) push(Uint8Array.of(m | 25, n >> 8, n & 255));
    else if (n < 0x100000000) push(Uint8Array.of(m | 26, n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255));
    else { const b = new Uint8Array(9); b[0] = m | 27; new DataView(b.buffer).setBigUint64(1, BigInt(n)); push(b); }
  };
  const write = (v) => {
    if (v === null || v === undefined) push(Uint8Array.of(0xf6));
    else if (typeof v === 'boolean') push(Uint8Array.of(v ? 0xf5 : 0xf4));
    else if (typeof v === 'number') {
      if (Number.isInteger(v) && Math.abs(v) < 2 ** 53) { if (v >= 0) head(0, v); else head(1, -1 - v); }
      else { const b = new Uint8Array(9); b[0] = 0xfb; new DataView(b.buffer).setFloat64(1, v); push(b); }
    }
    else if (typeof v === 'bigint') { if (v >= 0n) head(0, Number(v)); else head(1, Number(-1n - v)); }
    else if (typeof v === 'string') { const b = new TextEncoder().encode(v); head(3, b.length); push(b); }
    else if (v instanceof Uint8Array) { head(2, v.length); push(v); }
    else if (v instanceof ArrayBuffer) { const b = new Uint8Array(v); head(2, b.length); push(b); }
    else if (Array.isArray(v)) { head(4, v.length); for (const item of v) write(item); }
    else if (v instanceof Map) { head(5, v.size); for (const [k, item] of v) { write(String(k)); write(item); } }
    else if (typeof v === 'object') { const keys = Object.keys(v).filter((k) => v[k] !== undefined); head(5, keys.length); for (const k of keys) { write(k); write(v[k]); } }
    else throw new TypeError(`Cannot encode ${typeof v}`);
  };
  write(value);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
  return out;
}

export function decode(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let p = 0;
  const decoder = new TextDecoder();
  const length = (info) => {
    if (info < 24) return info;
    if (info === 24) return data[p++];
    if (info === 25) { const n = view.getUint16(p); p += 2; return n; }
    if (info === 26) { const n = view.getUint32(p); p += 4; return n; }
    if (info === 27) { const n = Number(view.getBigUint64(p)); p += 8; return n; }
    throw new RangeError('Indefinite-length CBOR is not supported');
  };
  const read = () => {
    const initial = data[p++];
    const major = initial >> 5, info = initial & 31;
    switch (major) {
      case 0: return length(info);
      case 1: return -1 - length(info);
      case 2: { const n = length(info); const slice = data.slice(p, p + n); p += n; return slice; }
      case 3: { const n = length(info); const text = decoder.decode(data.subarray(p, p + n)); p += n; return text; }
      case 4: { const n = length(info); const items = []; for (let i = 0; i < n; ++i) items.push(read()); return items; }
      case 5: { const n = length(info); const object = {}; for (let i = 0; i < n; ++i) { const key = read(); object[String(key)] = read(); } return object; }
      case 7:
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22 || info === 23) return null;
        if (info === 25) { const n = halfToFloat(view.getUint16(p)); p += 2; return n; }
        if (info === 26) { const n = view.getFloat32(p); p += 4; return n; }
        if (info === 27) { const n = view.getFloat64(p); p += 8; return n; }
        throw new RangeError(`Unsupported CBOR simple value ${info}`);
      default: throw new RangeError(`Unsupported CBOR major type ${major}`);
    }
  };
  return read();
}

function halfToFloat(h) {
  const sign = h & 0x8000 ? -1 : 1, exponent = (h >> 10) & 31, fraction = h & 1023;
  if (exponent === 0) return sign * fraction * 2 ** -24;
  if (exponent === 31) return fraction ? NaN : sign * Infinity;
  return sign * (1 + fraction / 1024) * 2 ** (exponent - 15);
}
