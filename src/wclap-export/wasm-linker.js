// Links a Cmajor DSP WebAssembly object (the relocatable module the browser compiler emits,
// with "linking" and "reloc.*" custom sections) into the prebuilt wclap-cmajor-shell module.
//
// This is deliberately not a general wasm linker. It only accepts what the pinned Cmajor
// compiler produces: no defined globals, no tables, no indirect calls, a single data section
// whose constants fit the shell's blob, and relocations of the few kinds LLVM emits for it.
// Anything else throws, loudly, at export time.
//
// Strategy: nothing inside the shell is ever renumbered. The link only APPENDS to the shell
// (types, functions, code, table elements) and PATCHES bytes inside its initialised data
// segment: the header struct (`ShellHeader.h`) and the blob that holds the DSP's data
// segments plus the CBOR metadata.

const MAGIC = "CMAJSHELLHDR";
const HEADER_VERSION = 1;

// ---------- binary reader ----------
class Reader {
  constructor(bytes, pos = 0) { this.b = bytes; this.p = pos; }
  u8() { if (this.p >= this.b.length) throw new Error("Unexpected end of WebAssembly section"); return this.b[this.p++]; }
  u32() {
    let r = 0, s = 0, x;
    do { x = this.b[this.p++]; r |= (x & 0x7f) << s; s += 7; } while (x & 0x80);
    return r >>> 0;
  }
  s32() {
    let r = 0, s = 0, x;
    do { x = this.b[this.p++]; r |= (x & 0x7f) << s; s += 7; } while (x & 0x80);
    if (s < 32 && (x & 0x40)) r |= -1 << s;
    return r;
  }
  bytes(n) { const v = this.b.subarray(this.p, this.p + n); this.p += n; return v; }
  name() { const n = this.u32(); return new TextDecoder().decode(this.bytes(n)); }
  eof() { return this.p >= this.b.length; }
}

// ---------- binary writer ----------
class Writer {
  constructor() { this.parts = []; this.len = 0; }
  push(arr) { const a = arr instanceof Uint8Array ? arr : Uint8Array.from(arr); this.parts.push(a); this.len += a.length; return this; }
  u8(v) { return this.push([v & 0xff]); }
  u32(v) { const out = []; do { let x = v & 0x7f; v >>>= 7; if (v) x |= 0x80; out.push(x); } while (v); return this.push(out); }
  s32(v) { const out = []; for (;;) { const x = v & 0x7f; v >>= 7; const done = (v === 0 && !(x & 0x40)) || (v === -1 && (x & 0x40)); out.push(done ? x : x | 0x80); if (done) break; } return this.push(out); }
  bytes() { const out = new Uint8Array(this.len); let o = 0; for (const p of this.parts) { out.set(p, o); o += p.length; } return out; }
}
const encU32 = (v) => new Writer().u32(v).bytes();
const section = (id, payload) => new Writer().u8(id).u32(payload.length).push(payload).bytes();
const padded5 = (v) => { const out = new Uint8Array(5); for (let i = 0; i < 5; i++) { let x = (v >>> (7 * i)) & 0x7f; if (i < 4) x |= 0x80; out[i] = x; } return out; };
const paddedS5 = (v) => { const out = new Uint8Array(5); for (let i = 0; i < 5; i++) { let x = (v >> (7 * i)) & 0x7f; if (i < 4) x |= 0x80; out[i] = x; } return out; };

// ---------- module parsing ----------
function parseSections(bytes) {
  if (bytes.length < 8 || bytes[0] !== 0 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) throw new Error("Not a WebAssembly module");
  const r = new Reader(bytes, 8);
  const secs = [];
  while (!r.eof()) {
    const id = r.u8(); const size = r.u32(); const start = r.p;
    let name = null;
    if (id === 0) name = r.name();
    secs.push({ id, name, payload: bytes.subarray(r.p, start + size) });
    r.p = start + size;
  }
  return secs;
}
const find = (secs, id, name) => secs.find((s) => s.id === id && (id !== 0 || s.name === name));

const VALTYPES = { 0x7f: "i32", 0x7e: "i64", 0x7d: "f32", 0x7c: "f64", 0x7b: "v128", 0x70: "funcref", 0x6f: "externref" };
function parseTypes(sec) {
  if (!sec) return [];
  const r = new Reader(sec.payload); const n = r.u32(); const out = [];
  for (let i = 0; i < n; i++) {
    const start = r.p; const form = r.u8(); if (form !== 0x60) throw new Error("Unsupported type form in DSP object");
    const np = r.u32(); const params = [...r.bytes(np)].map((t) => VALTYPES[t] ?? t);
    const nr = r.u32(); const results = [...r.bytes(nr)].map((t) => VALTYPES[t] ?? t);
    out.push({ bytes: sec.payload.subarray(start, r.p), params, results });
  }
  return out;
}
function parseImports(sec) {
  if (!sec) return [];
  const r = new Reader(sec.payload); const n = r.u32(); const out = [];
  for (let i = 0; i < n; i++) {
    const module = r.name(), name = r.name(), kind = r.u8();
    let type;
    if (kind === 0) type = r.u32();
    else if (kind === 1) { r.u8(); const f = r.u8(); r.u32(); if (f & 1) r.u32(); }
    else if (kind === 2) { const f = r.u8(); type = { minimum: r.u32(), maximum: f & 1 ? r.u32() : null, shared: !!(f & 2) }; }
    else if (kind === 3) { r.u8(); r.u8(); }
    else throw new Error("Unknown import kind " + kind);
    out.push({ module, name, kind, type });
  }
  return out;
}
function parseFunctions(sec) { if (!sec) return []; const r = new Reader(sec.payload); const n = r.u32(); const out = []; for (let i = 0; i < n; i++) out.push(r.u32()); return out; }
function parseExports(sec) { if (!sec) return []; const r = new Reader(sec.payload); const n = r.u32(); const out = []; for (let i = 0; i < n; i++) out.push({ name: r.name(), kind: r.u8(), index: r.u32() }); return out; }
function parseCodeBodies(payload) { const r = new Reader(payload); const n = r.u32(); const out = []; for (let i = 0; i < n; i++) { const size = r.u32(); out.push(payload.subarray(r.p, r.p + size)); r.p += size; } return out; }
function parseDataSegments(sec) {
  if (!sec) return [];
  const r = new Reader(sec.payload); const n = r.u32(); const out = [];
  for (let i = 0; i < n; i++) {
    const flags = r.u32();
    if (flags === 2) r.u32();
    if (flags !== 1) skipConstExpression(r);
    const size = r.u32(); const dataStart = r.p; const data = r.bytes(size);
    out.push({ flags, data, dataStartInPayload: dataStart });
  }
  return out;
}
/** Skips an active segment's offset expression (`i32.const n end` or `global.get i end`); the
 *  LEB bytes of a large constant can themselves contain 0x0b, so scanning for `end` is unsafe. */
function skipConstExpression(r) {
  for (;;) {
    const op = r.u8();
    if (op === 0x0b) return;
    if (op === 0x41 || op === 0x23) r.s32();           // i32.const / global.get
    else if (op === 0x42) { while (r.u8() & 0x80); }    // i64.const
    else throw new Error(`Unsupported opcode 0x${op.toString(16)} in a data segment offset`);
  }
}

function parseTable(sec) {
  if (!sec) throw new Error("The shell module has no function table");
  const r = new Reader(sec.payload); const n = r.u32(); if (n !== 1) throw new Error("Expected exactly one table in the shell");
  const elemType = r.u8(); const flags = r.u8(); const min = r.u32(); const max = flags & 1 ? r.u32() : null;
  return { elemType, flags, min, max };
}

// ---------- object-file metadata ----------
function parseLinking(sec) {
  if (!sec) throw new Error("The DSP module has no linking section: it is not a relocatable object");
  const r = new Reader(sec.payload); const version = r.u32(); if (version !== 2) throw new Error("Unsupported linking section version " + version);
  const symbols = [], segments = [];
  while (!r.eof()) {
    const type = r.u8(); const size = r.u32(); const end = r.p + size;
    if (type === 5) { const n = r.u32(); for (let i = 0; i < n; i++) segments.push({ name: r.name(), align: r.u32(), flags: r.u32() }); }
    else if (type === 6) { if (r.u32() !== 0) throw new Error("DSP object declares init functions"); }
    else if (type === 7) { if (r.u32() !== 0) throw new Error("DSP object uses COMDAT groups"); }
    else if (type === 8) {
      const n = r.u32();
      for (let i = 0; i < n; i++) {
        const kind = r.u8(); const flags = r.u32(); const undefined_ = !!(flags & 0x10); const explicitName = !!(flags & 0x40);
        const sym = { kind, flags, undefined: undefined_ };
        if (kind === 0 || kind === 2 || kind === 4 || kind === 5) { sym.index = r.u32(); if (!undefined_ || explicitName) sym.name = r.name(); }
        else if (kind === 1) { sym.name = r.name(); if (!undefined_) { sym.segment = r.u32(); sym.offset = r.u32(); sym.size = r.u32(); } }
        else if (kind === 3) { sym.section = r.u32(); }
        else throw new Error("Unknown symbol kind " + kind);
        symbols.push(sym);
      }
    }
    r.p = end;
  }
  return { symbols, segments };
}
const RELOC_WITH_ADDEND = new Set([3, 4, 5, 8, 9, 11, 12, 14, 15, 16, 22, 23]);
function parseRelocs(sec) {
  if (!sec) return [];
  const r = new Reader(sec.payload); r.u32(); const n = r.u32(); const entries = [];
  for (let i = 0; i < n; i++) {
    const type = r.u8(); const offset = r.u32(); const index = r.u32();
    entries.push({ type, offset, index, addend: RELOC_WITH_ADDEND.has(type) ? r.s32() : 0 });
  }
  return entries;
}

/** The DSP object's exported functions with their wasm signatures, keyed by export name. */
export function describeDspExports(dspBytes) {
  const dsp = parseSections(dspBytes);
  const types = parseTypes(find(dsp, 1));
  const imports = parseImports(find(dsp, 2));
  const funcs = parseFunctions(find(dsp, 3));
  const importFuncs = imports.filter((i) => i.kind === 0);
  const out = {};
  for (const e of parseExports(find(dsp, 7))) {
    if (e.kind !== 0) continue;
    const typeIndex = e.index < importFuncs.length ? importFuncs[e.index].type : funcs[e.index - importFuncs.length];
    out[e.name] = { params: types[typeIndex].params, results: types[typeIndex].results };
  }
  return out;
}

/**
 * @param {Uint8Array} shellBytes - the prebuilt shell's module.wasm
 * @param {Uint8Array} dspBytes - the compiler's DSP object
 * @param {{ metadata: Uint8Array, slots: string[] }} options - CBOR metadata to embed, and the DSP
 *   export names to place in the header's handler table, in slot order
 * @returns {{ bytes: Uint8Array, stats: object }}
 */
export function linkCmajorIntoShell(shellBytes, dspBytes, { metadata, slots, debug = {} }) {
  shellBytes = new Uint8Array(shellBytes); // never mutate the caller's copy: the header is patched in place
  const shell = parseSections(shellBytes), dsp = parseSections(dspBytes);
  const sTypes = parseTypes(find(shell, 1)), dTypes = parseTypes(find(dsp, 1));
  const sImports = parseImports(find(shell, 2)), dImports = parseImports(find(dsp, 2));
  const sFuncs = parseFunctions(find(shell, 3)), dFuncs = parseFunctions(find(dsp, 3));
  const sExports = parseExports(find(shell, 7)), dExports = parseExports(find(dsp, 7));
  const sTable = parseTable(find(shell, 4));
  const linking = parseLinking(find(dsp, 0, "linking"));
  const codeRelocs = parseRelocs(find(dsp, 0, "reloc.CODE"));
  const dataRelocs = parseRelocs(find(dsp, 0, "reloc.DATA"));
  const dData = parseDataSegments(find(dsp, 11));
  const sData = parseDataSegments(find(shell, 11));

  if (find(dsp, 6) && parseFunctions(find(dsp, 6)).length) throw new Error("DSP object defines globals");
  if (find(dsp, 4)) throw new Error("DSP object defines a table");
  if (find(dsp, 9)) throw new Error("DSP object defines element segments");
  if (find(dsp, 8)) throw new Error("DSP object has a start function");
  for (const imp of dImports) {
    if (imp.kind === 2) continue; // its linear memory: becomes the shell's
    if (imp.kind === 3 && imp.name === "__stack_pointer") continue;
    if (imp.kind === 0) continue; // resolved against shell exports below
    throw new Error(`DSP object imports unsupported ${imp.module}.${imp.name}`);
  }

  const sImportFuncs = sImports.filter((i) => i.kind === 0).length;
  const sFuncCount = sImportFuncs + sFuncs.length;
  const dImportFuncs = dImports.filter((i) => i.kind === 0);
  const exportIndex = (kind, name) => {
    const e = sExports.find((x) => x.kind === kind && x.name === name);
    if (!e) throw new Error(`The shell does not export ${name}, which the DSP needs`);
    return e.index;
  };

  // --- header + blob in the shell's data ---
  const magic = new TextEncoder().encode(MAGIC);
  let hdrSeg = null, hdrOff = -1;
  for (const seg of sData) {
    outer: for (let k = 0; k + magic.length <= seg.data.length; k++) {
      for (let j = 0; j < magic.length; j++) if (seg.data[k + j] !== magic[j]) continue outer;
      hdrSeg = seg; hdrOff = k; break;
    }
    if (hdrSeg) break;
  }
  if (!hdrSeg) throw new Error("The shell header was not found in the module's data");
  const hdr = new DataView(hdrSeg.data.buffer, hdrSeg.data.byteOffset + hdrOff);
  const version = hdr.getUint32(16, true), maxHandlers = hdr.getUint32(20, true);
  if (version !== HEADER_VERSION) throw new Error(`Shell header version ${version} is not supported by this linker (expected ${HEADER_VERSION})`);
  const H = { self: 24, blob: 28, blobSize: 32, initialise: 36, advanceBlock: 40, numHandlers: 44, handlers: 48, metaOffset: 48 + 4 * maxHandlers, metaSize: 52 + 4 * maxHandlers };
  const hdrSelf = hdr.getUint32(H.self, true), blobAddr = hdr.getUint32(H.blob, true), blobSize = hdr.getUint32(H.blobSize, true);
  const segAddr = hdrSelf - hdrOff;
  const blobOffInSeg = blobAddr - segAddr;
  if (blobOffInSeg < 0 || blobOffInSeg + blobSize > hdrSeg.data.length) throw new Error("The shell blob is not inside the header's data segment");
  if (slots.length > maxHandlers) throw new Error(`The patch has ${slots.length} endpoint handlers; the shell holds ${maxHandlers}`);

  // --- place DSP data segments, then metadata, into the blob ---
  let cursor = 0; const segBase = [];
  dData.forEach((seg, i) => { const align = 1 << (linking.segments[i]?.align ?? 0); cursor = (cursor + align - 1) & ~(align - 1); segBase.push(cursor); cursor += seg.data.length; });
  cursor = (cursor + 15) & ~15; const metaOffset = cursor; cursor += metadata.length;
  if (cursor > blobSize) throw new Error(`The patch's constant data and metadata (${cursor} bytes) exceed the shell's blob (${blobSize} bytes)`);
  const blob = new Uint8Array(cursor);
  dData.forEach((seg, i) => blob.set(seg.data, segBase[i]));
  blob.set(metadata, metaOffset);

  // --- index maps ---
  const typeBase = sTypes.length;
  const dspFuncIndex = (dspIdx) => {
    if (dspIdx < dImportFuncs.length) return exportIndex(0, dImportFuncs[dspIdx].name);
    return sFuncCount + (dspIdx - dImportFuncs.length);
  };
  const dspGlobalIndex = (dspIdx) => {
    const imps = dImports.filter((i) => i.kind === 3);
    if (dspIdx < imps.length) return exportIndex(3, imps[dspIdx].name);
    throw new Error("DSP object defines globals");
  };
  const symbolValue = (sym) => {
    switch (sym.kind) {
      case 0: return dspFuncIndex(sym.index);
      case 1: if (sym.undefined) throw new Error("Undefined data symbol " + sym.name); return blobAddr + segBase[sym.segment] + sym.offset;
      case 2: return dspGlobalIndex(sym.index);
      default: throw new Error("Unsupported symbol kind " + sym.kind);
    }
  };
  let nextTableSlot = sTable.min; const tableElems = []; const tableSlotOf = new Map();
  const slotFor = (mergedFuncIdx) => {
    if (!tableSlotOf.has(mergedFuncIdx)) { tableSlotOf.set(mergedFuncIdx, nextTableSlot); tableElems.push(mergedFuncIdx); nextTableSlot++; }
    return tableSlotOf.get(mergedFuncIdx);
  };

  // --- apply relocations ---
  const apply = (buf, entries) => {
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    for (const rel of entries) {
      const sym = linking.symbols[rel.index]; const at = rel.offset; let v;
      switch (rel.type) {
        case 0: buf.set(padded5(symbolValue(sym)), at); break;                            // FUNCTION_INDEX_LEB
        case 1: buf.set(paddedS5(slotFor(symbolValue(sym))), at); break;                  // TABLE_INDEX_SLEB
        case 2: view.setUint32(at, slotFor(symbolValue(sym)), true); break;               // TABLE_INDEX_I32
        case 3: v = symbolValue(sym) + rel.addend; buf.set(padded5(v), at); break;       // MEMORY_ADDR_LEB
        case 4: v = symbolValue(sym) + rel.addend; buf.set(paddedS5(v), at); break;      // MEMORY_ADDR_SLEB
        case 5: v = symbolValue(sym) + rel.addend; view.setUint32(at, v >>> 0, true); break; // MEMORY_ADDR_I32
        case 6: buf.set(padded5(typeBase + rel.index), at); break;                        // TYPE_INDEX_LEB
        case 7: buf.set(padded5(symbolValue(sym)), at); break;                            // GLOBAL_INDEX_LEB
        default: throw new Error("Unsupported relocation type " + rel.type);
      }
    }
  };
  const code = new Uint8Array(find(dsp, 10).payload);
  apply(code, codeRelocs);
  if (dataRelocs.length) {
    const tmp = new Uint8Array(find(dsp, 11).payload); apply(tmp, dataRelocs);
    dData.forEach((seg, i) => blob.set(tmp.subarray(seg.dataStartInPayload, seg.dataStartInPayload + seg.data.length), segBase[i]));
  }
  const dBodies = parseCodeBodies(code);

  // --- patch the header and blob (inside the shell's data segment, which is what its memory initialiser copies) ---
  const dspExportFunc = (name) => {
    const e = dExports.find((x) => x.kind === 0 && x.name === name);
    if (!e) throw new Error(`The DSP does not export ${name}`);
    return dspFuncIndex(e.index);
  };
  const initSlot = slotFor(dspExportFunc("initialise")), advanceSlot = slotFor(dspExportFunc("advanceBlock"));
  const handlerSlots = slots.map((name) => slotFor(dspExportFunc(name)));
  if (!debug.skipData) {
    hdr.setUint32(H.initialise, initSlot, true);
    hdr.setUint32(H.advanceBlock, advanceSlot, true);
    hdr.setUint32(H.numHandlers, slots.length, true);
    handlerSlots.forEach((slot, i) => hdr.setUint32(H.handlers + 4 * i, slot, true));
    hdr.setUint32(H.metaOffset, metaOffset, true);
    hdr.setUint32(H.metaSize, metadata.length, true);
    hdrSeg.data.set(blob, blobOffInSeg);
  }

  // --- emit ---
  const out = new Writer().push([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);
  const elemSeg = () => { const w = new Writer().u8(0).u8(0x41).s32(sTable.min).u8(0x0b).u32(tableElems.length); for (const f of tableElems) w.u32(f); return w.bytes(); };
  let elemEmitted = !!find(shell, 9);
  for (const sec of shell) {
    let payload = sec.payload;
    if (debug.skipCode) { out.push(sec.id === 0 ? section(0, new Writer().push(encU32(new TextEncoder().encode(sec.name).length)).push(new TextEncoder().encode(sec.name)).push(payload).bytes()) : section(sec.id, payload)); continue; }
    if (!elemEmitted && (sec.id === 12 || sec.id === 10) && tableElems.length) { out.push(section(9, new Writer().u32(1).push(elemSeg()).bytes())); elemEmitted = true; }
    if (sec.id === 1) { const w = new Writer().u32(sTypes.length + dTypes.length); for (const t of sTypes) w.push(t.bytes); for (const t of dTypes) w.push(t.bytes); payload = w.bytes(); }
    else if (sec.id === 3) { const w = new Writer().u32(sFuncs.length + dFuncs.length); for (const t of sFuncs) w.u32(t); for (const t of dFuncs) w.u32(typeBase + t); payload = w.bytes(); }
    else if (sec.id === 4) { const w = new Writer().u32(1).u8(sTable.elemType).u8(sTable.flags).u32(nextTableSlot); if (sTable.flags & 1) w.u32(Math.max(sTable.max, nextTableSlot)); payload = w.bytes(); }
    else if (sec.id === 9) { const r = new Reader(sec.payload); const n = r.u32(); payload = new Writer().u32(n + 1).push(sec.payload.subarray(r.p)).push(elemSeg()).bytes(); }
    else if (sec.id === 10) { const bodies = parseCodeBodies(sec.payload); const w = new Writer().u32(bodies.length + dBodies.length); for (const b of [...bodies, ...dBodies]) w.u32(b.length).push(b); payload = w.bytes(); }
    else if (sec.id === 0 && sec.name === "name") continue; // function names would be stale
    if (sec.id === 0) out.push(section(0, new Writer().push(encU32(new TextEncoder().encode(sec.name).length)).push(new TextEncoder().encode(sec.name)).push(payload).bytes()));
    else out.push(section(sec.id, payload));
  }
  // Some WCLAP hosts size the plug-in's memory from the module's byte length alone and never
  // read its declared minimum, so a module whose memory needs exceed its file size (ours: an
  // 8 MiB shadow stack) fails to instantiate there. An inert custom section pads the file up to
  // the declared minimum; it compresses to almost nothing and costs no memory at run time.
  const memoryImport = sImports.find((i) => i.kind === 2);
  const requiredBytes = (memoryImport?.type?.minimum ?? 0) * 65536;
  const bodyLength = out.len;
  if (requiredBytes > bodyLength) {
    const name = new TextEncoder().encode("wclap-cmajor-shell.padding");
    const padding = requiredBytes - bodyLength - (1 + 5 + 1 + name.length);   // id, padded size, name
    if (padding > 0) {
      const w = new Writer().u8(0).push(padded5(padding + 1 + name.length)).u8(name.length).push(name).push(new Uint8Array(padding));
      out.push(w.bytes());
    }
  }
  return {
    bytes: out.bytes(),
    stats: { dspFunctions: dFuncs.length, dspTypes: dTypes.length, codeRelocations: codeRelocs.length, dataRelocations: dataRelocs.length, blobBytes: blob.length, metadataBytes: metadata.length, tableSlots: tableElems.length },
  };
}
