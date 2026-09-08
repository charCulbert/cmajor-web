// Recovers the ABI of a compiled Cmajor patch from the JavaScript class the browser compiler
// generates: which wasm exports drive each endpoint, how their payloads are laid out, and
// where streams, output values and output event FIFOs live relative to the state and io
// structs. Everything comes from the class's own accessor closures, whose source is a fixed
// template for the pinned compiler version, so no compiler patch is needed.
//
// The result is the metadata wclap-cmajor-shell's Engine reads (format "wclap-cmajor-shell/1")
// plus the DSP object bytes and the ordered list of export names for the header's slots.

import { describeDspExports } from "./wasm-linker.js";

export const METADATA_FORMAT = "wclap-cmajor-shell/1";
const DEFAULT_MAX_BLOCK_SIZE = 128;

const PRIMITIVE_KINDS = new Set(["float32", "float64", "int32", "int64", "bool", "void"]);
const WASM_ARG_FOR_KIND = { float32: "f32", float64: "f64", int32: "i32", int64: "i64", bool: "i32", void: "none" };
const SETTER_KINDS = { Int32: "int32", Float32: "float32", BigInt64: "int64", Float64: "float64" };

/**
 * @param {string} generatedCode - the compiler's JavaScript class source
 * @param {{ manifest: object, manifestPath: string, compilerVersion?: string, simd?: boolean }} options
 * @returns {Promise<{ wasm: Uint8Array, metadata: object, slots: string[] }>}
 */
export async function extractRuntimeInfo(generatedCode, { manifest, manifestPath, compilerVersion = "unknown", simd = true }) {
  const GeneratedClass = new Function(`return (${generatedCode})`)();
  const wrapper = new GeneratedClass();
  const variant = simd && typeof wrapper._getWasmBytesSIMD === "function" ? "SIMD" : "NonSIMD";
  if (typeof wrapper[`_getWasmBytes${variant}`] !== "function") throw new Error("The compiled patch has no WebAssembly module");
  const wasm = new Uint8Array(wrapper[`_getWasmBytes${variant}`]());
  const exportTypes = describeDspExports(wasm);

  // Instantiating fills in the per-endpoint closures whose source carries the addresses.
  await wrapper[`_initialiseInternal${variant}`](1, 44100);
  const initSource = wrapper[`_initialiseInternal${variant}`].toString();
  const state = number(initSource, /this\.stateAddress = (\d+);/, "state address");
  const scratch = number(initSource, /this\.scratchSpaceAddress = (\d+);/, "scratch address");
  const advance = initSource.match(/advanceBlock \((\d+), (\d+), numFrames\)/);
  if (!advance) throw new Error("The compiled patch has no advanceBlock entry point");
  const io = Number(advance[2]);
  const pages = number(initSource, /initial: (\d+)/, "memory size");
  if (!(state < io && io <= scratch)) throw new Error(`Unexpected memory layout: state ${state}, io ${io}, scratch ${scratch}`);
  const memoryEnd = pages * 65536;
  const stateSize = io - state, ioSize = Math.max(16, scratch - io);
  const scratchSize = Math.min(Math.max(65536, memoryEnd - scratch), 1 << 20);
  const maxBlockSize = Number(generatedCode.match(/numFramesToWrite > (\d+)|maxNumFramesToRead > (\d+)/)?.slice(1).find(Boolean) ?? DEFAULT_MAX_BLOCK_SIZE);

  const closure = (name) => (typeof wrapper[name] === "function" ? wrapper[name].toString() : null);
  const method = (name) => { const fn = Object.getPrototypeOf(wrapper)[name]; return typeof fn === "function" ? fn.toString() : null; };
  const packers = new Map(), unpackers = new Map();
  const packerLayout = (name) => { if (!packers.has(name)) packers.set(name, parsePacker(closure(name), name)); return packers.get(name); };
  const unpackerLayout = (name) => { if (!unpackers.has(name)) unpackers.set(name, parseUnpacker(closure(name), name)); return unpackers.get(name); };

  const slots = [];
  const slotOf = (exportName, expected) => {
    const type = exportTypes[exportName];
    if (!type) throw new Error(`The DSP does not export ${exportName}`);
    if (expected && (type.params.length !== expected.length || expected.some((p, i) => p !== type.params[i])))
      throw new Error(`${exportName} has signature (${type.params.join(", ")}), expected (${expected.join(", ")})`);
    let index = slots.indexOf(exportName);
    if (index < 0) { index = slots.length; slots.push(exportName); }
    return index;
  };
  const kindOf = (dataType) => (dataType && PRIMITIVE_KINDS.has(dataType.type) ? dataType.type : "pointer");
  const describe = (endpoint) => ({
    ...endpoint,
    id: endpoint.endpointID,
    kind: endpoint.endpointType,
    purpose: endpoint.purpose ?? "",
    dataTypes: endpoint.dataTypes ?? (endpoint.dataType ? [endpoint.dataType] : []),
    annotation: endpoint.annotation ?? {},
  });

  const inputs = wrapper.getInputEndpoints().map((endpoint) => {
    const id = endpoint.endpointID;
    const out = describe(endpoint);
    if (out.kind === "stream") {
      const src = closure(`_setInputFramesInternal_${id}`);
      if (!src) throw new Error(`No stream writer for input ${id}`);
      out.channels = number(src, /Math\.min \((\d+),/, `channel count of ${id}`);
      out.ioOffset = number(src, /let dest = (\d+);/, `address of ${id}`) - io;
    } else if (out.kind === "value") {
      const src = method(`setInputValue_${id}`);
      if (!src) throw new Error(`No value setter for input ${id}`);
      const packer = src.match(/this\.(_pack_\S+) \(this\.scratchSpaceAddress, newValue\);/);
      const exportName = src.match(/exports\.(_setValue_\S+) \(this\.stateAddress, this\.scratchSpaceAddress, numFramesToReachValue\)/)?.[1];
      if (!packer || !exportName) throw new Error(`Unrecognised value setter for input ${id}`);
      out.valueKind = kindOf(out.dataTypes[0]);
      out.layout = packerLayout(packer[1]);
      out.slot = slotOf(exportName, ["i32", "i32", "i32"]);
    } else if (out.kind === "event") {
      out.events = out.dataTypes.map((dataType, typeIndex) => {
        const src = method(out.dataTypes.length === 1 ? `sendInputEvent_${id}` : `sendInputEvent_${id}_${typeIndex + 1}`);
        if (!src) throw new Error(`No event sender for input ${id} type ${typeIndex}`);
        const call = src.match(/exports\.(_sendEvent_\S+) \(this\.stateAddress(?:, (this\.scratchSpaceAddress|eventValue))?\)/);
        if (!call) throw new Error(`Unrecognised event sender for input ${id}`);
        const [, exportName, argument] = call;
        const valueKind = kindOf(dataType);
        const event = { typeIndex, valueKind, layout: [] };
        if (argument === "this.scratchSpaceAddress") {
          const packer = src.match(/this\.(_pack_\S+) \(this\.scratchSpaceAddress, eventValue\);/);
          if (!packer) throw new Error(`Unrecognised packed event sender for input ${id}`);
          event.layout = packerLayout(packer[1]);
          event.wasmArg = "ptr";
          event.slot = slotOf(exportName, ["i32", "i32"]);
        } else if (argument === "eventValue") {
          event.wasmArg = WASM_ARG_FOR_KIND[valueKind];
          if (!event.wasmArg || event.wasmArg === "none") throw new Error(`Event ${id} passes a ${valueKind} by value`);
          event.slot = slotOf(exportName, ["i32", event.wasmArg]);
        } else {
          event.wasmArg = "none";
          event.slot = slotOf(exportName, ["i32"]);
        }
        return event;
      });
    }
    return out;
  });

  const outputs = wrapper.getOutputEndpoints().map((endpoint) => {
    const id = endpoint.endpointID;
    const out = describe(endpoint);
    if (out.kind === "stream") {
      const src = closure(`_getOutputFramesInternal_${id}`);
      if (!src) throw new Error(`No stream reader for output ${id}`);
      out.channels = number(src, /Math\.min \((\d+),/, `channel count of ${id}`);
      out.ioOffset = number(src, /let source = (\d+);/, `address of ${id}`) - io;
    } else if (out.kind === "value") {
      const src = closure(`_unpackValueInternal_${id}`);
      if (!src) throw new Error(`No value reader for output ${id}`);
      const read = parseReadExpression(src.match(/return ([\s\S]*?);\s*\}\s*$/)?.[1] ?? "", "(\\d+)", unpackerLayout);
      out.stateOffset = read.address - state;
      out.valueKind = kindOf(out.dataTypes[0]);
      out.layout = read.layout;
    } else if (out.kind === "event") {
      const countSrc = closure(`_unpackEventCountInternal_${id}`);
      const readSrc = closure(`_readEventInternal_${id}`);
      if (!countSrc || !readSrc) throw new Error(`No event reader for output ${id}`);
      out.countOffset = number(countSrc, /getInt32 \((\d+), true\)/, `event count of ${id}`) - state;
      const head = readSrc.match(/const eventAddress = (\d+) \+ \((\d+) \* index\);/);
      if (!head) throw new Error(`Unrecognised event reader for output ${id}`);
      out.eventsOffset = Number(head[1]) - state;
      out.eventStride = Number(head[2]);
      out.maxEvents = Math.floor((stateSize - out.eventsOffset) / out.eventStride);
      out.frameOffset = Number(readSrc.match(/const frame = memoryDataView\.getInt32 \(eventAddress(?: \+ (\d+))?, true\);/)?.[1] ?? 0);
      out.typeIndexOffset = Number(readSrc.match(/const typeIndex = memoryDataView\.getInt32 \(eventAddress(?: \+ (\d+))?, true\);/)?.[1] ?? 0);
      const cases = [...readSrc.matchAll(/case (\d+): return \{ frame, typeIndex, event: ([\s\S]*?) \};/g)];
      const expressions = cases.length ? cases.map((m) => m[2]) : [readSrc.match(/return \{ frame, typeIndex: 0, event: ([\s\S]*?) \};/)?.[1]];
      out.types = out.dataTypes.map((dataType, typeIndex) => {
        const expression = expressions[typeIndex];
        if (expression === undefined) throw new Error(`Missing event type ${typeIndex} for output ${id}`);
        if (expression === "null") return { valueKind: "void", offset: 0, layout: [] };
        const read = parseReadExpression(expression, "eventAddress(?: \\+ (\\d+))?", unpackerLayout);
        return { valueKind: kindOf(dataType), offset: read.address, layout: read.layout };
      });
    }
    return out;
  });

  const metadata = {
    format: METADATA_FORMAT,
    name: manifest?.name || manifestPath.replace(/\.cmajorpatch$/i, "").split("/").at(-1),
    manifest, manifestPath, compilerVersion, simd: variant === "SIMD",
    stateSize, ioSize, scratchSize, maxBlockSize,
    inputs, outputs, slots,
  };
  return { wasm, metadata, slots };
}

function number(source, pattern, what) {
  const match = source?.match(pattern);
  if (!match) throw new Error(`Could not read the ${what} from the compiled patch`);
  return Number(match[1]);
}

/** Layout of a `_pack_*` closure: one field per setter statement, offsets relative to `address`. */
function parsePacker(source, name) {
  if (!source) throw new Error(`Missing packer ${name}`);
  if (/^_pack_(f32|f64|i32|i64)$/.test(name)) return [];   // bare primitive
  const layout = [];
  for (const m of source.matchAll(/memoryDataView\.set(Int32|Float32|BigInt64|Float64) \(address(?: \+ (\d+))?, newValue(\S*?), true\);/g))
    layout.push({ path: m[3], kind: SETTER_KINDS[m[1]], offset: Number(m[2] ?? 0) });
  for (const m of source.matchAll(/memoryDataView\.setUint8 \(address(?: \+ (\d+))?, newValue(\S*?) \? \((\d+) \|/g))
    layout.push({ path: m[2], kind: "bool", bit: Number(m[1] ?? 0) * 8 + Math.log2(Number(m[3])) });
  if (name === "_pack_b" && layout.length === 1) return [];  // bare bool
  if (!layout.length) throw new Error(`Unrecognised packer ${name}`);
  return layout;
}

/** Layout of an `_unpack_*` closure: walks the returned object/array literal. */
function parseUnpacker(source, name) {
  if (!source) throw new Error(`Missing unpacker ${name}`);
  const expression = source.match(/return ([\s\S]*?);\s*\}\s*$/)?.[1];
  if (!expression) throw new Error(`Unrecognised unpacker ${name}`);
  const layout = [];
  walkLiteral(expression.trim(), "", layout);
  return layout;
}

const GETTER_KINDS = { Int32: "int32", Float32: "float32", BigInt64: "int64", Float64: "float64" };

/** Parses the literal an unpacker returns, appending fields with paths built from keys and indices. */
function walkLiteral(text, path, layout) {
  text = text.trim();
  let m;
  if ((m = text.match(/^memoryDataView\.get(Int32|Float32|BigInt64|Float64) \(address(?: \+ (\d+))?, true\)$/))) { layout.push({ path, kind: GETTER_KINDS[m[1]], offset: Number(m[2] ?? 0) }); return; }
  if ((m = text.match(/^\(\(memoryDataView\.getUint8 \(address(?: \+ (\d+))?\) & (\d+)\) !== 0\)$/))) { layout.push({ path, kind: "bool", bit: Number(m[1] ?? 0) * 8 + Math.log2(Number(m[2])) }); return; }
  if (text.startsWith("{") || text.startsWith("[")) {
    const isObject = text.startsWith("{");
    for (const [key, value] of splitLiteral(text.slice(1, -1), isObject))
      walkLiteral(value, path + (isObject ? `.${key}` : `[${key}]`), layout);
    return;
  }
  throw new Error(`Unrecognised value reader: ${text.slice(0, 80)}`);
}

/** Splits the inside of an object/array literal at top-level commas. */
function splitLiteral(body, isObject) {
  const parts = [];
  let depth = 0, start = 0, inString = false;
  for (let i = 0; i <= body.length; i++) {
    const c = body[i];
    if (inString) { if (c === '"') inString = false; continue; }
    if (c === '"') inString = true;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if ((c === "," || i === body.length) && depth === 0) {
      const part = body.slice(start, i).trim();
      if (part) parts.push(part);
      start = i + 1;
    }
  }
  return parts.map((part, index) => {
    if (!isObject) return [String(index), part];
    const m = part.match(/^"((?:[^"\\]|\\.)*)": ([\s\S]*)$/);
    if (!m) throw new Error(`Unrecognised object member: ${part.slice(0, 60)}`);
    return [m[1], m[2]];
  });
}

/**
 * A read of one value at some base: either an inline primitive getter, an inline bool, or a
 * call to an unpacker. Returns the address (or offset from the base) and the layout there.
 */
function parseReadExpression(expression, basePattern, unpackerLayout) {
  expression = expression.trim();
  let m;
  if ((m = expression.match(new RegExp(`^this\\.(_unpack_\\S+) \\(${basePattern}\\)$`))))
    return { address: Number(m[2] ?? 0), layout: unpackerLayout(m[1]) };
  if ((m = expression.match(new RegExp(`^memoryDataView\\.get(Int32|Float32|BigInt64|Float64) \\(${basePattern}, true\\)$`))))
    return { address: Number(m[2] ?? 0), layout: [] };
  if ((m = expression.match(new RegExp(`^\\(\\(memoryDataView\\.getUint8 \\(${basePattern}\\) & (\\d+)\\) !== 0\\)$`))))
    return { address: Number(m[1] ?? 0), layout: [{ path: "", kind: "bool", bit: Math.log2(Number(m[2])) }] };
  throw new Error(`Unrecognised read expression: ${expression.slice(0, 80)}`);
}
