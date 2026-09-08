// Hosts a Cmajor patch GUI the way the native Cmajor plug-in does: a PatchConnection
// bridged to the plug-in over CBOR messages, and either the patch's own view or Cmajor's
// generic view created through cmaj_api. Project files are served by the plug-in under
// ./patch/<path>, so a patch's modules and assets load as ordinary same-origin URLs.
import { PatchConnection } from './cmaj_api/cmaj-patch-connection.js';
import { createPatchViewHolder } from './cmaj_api/cmaj-patch-view.js';
import { parametersOf } from './endpoints.js';

const baseURL = new URL('./', import.meta.url).href;

export class LoaderPatchConnection extends PatchConnection {
  /**
   * @param {object} meta - the package metadata (endpoints, layouts, manifest)
   * @param {(message: object) => void} sendToPlugin
   * @param {{ params?: number[], stored?: object }} initial
   */
  constructor(meta, sendToPlugin, initial = {}) {
    super();
    this.meta = meta;
    this.manifest = meta.manifest;
    this.sendToPlugin = sendToPlugin;
    this.inputs = meta.inputs;
    this.outputs = meta.outputs;
    this.parameters = parametersOf(meta);
    this.parameterIndex = new Map(this.parameters.map((p, index) => [p.id, index]));
    this.inputIndex = new Map(meta.inputs.map((input, index) => [input.id, index]));
    this.outputIndex = new Map(meta.outputs.map((output, index) => [output.id, index]));
    this.values = new Map(this.parameters.map((p, index) => [p.id, initial.params?.[index] ?? initialValue(p)]));
    this.storedState = new Map(Object.entries(initial.stored ?? {}));
    this.outputListeners = new Map();
  }

  async getCmajorVersion() { return this.meta.compilerVersion ?? 'unknown'; }

  getResourceAddress(path) { return new URL(`patch/${normalisePath(path)}`, baseURL).href; }

  /** Fetches a file from the loaded patch, as hosted patch workers expect. */
  async readResource(path) { return fetch(this.getResourceAddress(path)); }

  /** Decodes an audio file from the patch into { frames: number[][], sampleRate }. */
  async readResourceAsAudioData(path) {
    const response = await this.readResource(path);
    if (!response.ok) throw new Error(`Could not read ${path} (${response.status})`);
    const encoded = await response.arrayBuffer();
    const context = new OfflineAudioContext(1, 1, 48000);
    const buffer = await context.decodeAudioData(encoded);
    const frames = Array.from({ length: buffer.length }, () => []);
    for (let channel = 0; channel < buffer.numberOfChannels; ++channel) {
      const samples = buffer.getChannelData(channel);
      for (let i = 0; i < buffer.length; ++i) frames[i].push(samples[i]);
    }
    return { frames, sampleRate: buffer.sampleRate };
  }

  /** The plug-in reports a parameter changed by the host (automation, host controls). */
  parameterChanged(index, value) {
    const parameter = this.parameters[index];
    if (!parameter) return;
    this.values.set(parameter.id, value);
    this.deliver('param_value', { endpointID: parameter.id, value });
  }

  /** Output endpoint events and values polled from the plug-in. */
  outputEvent(outputIndex, frame, typeIndex, bytes) {
    const output = this.outputs[outputIndex];
    const listeners = this.outputListeners.get(output?.id);
    if (!output || !listeners?.size) return;
    const type = output.types?.[typeIndex];
    const value = type ? unpack(bytes, type.layout, type.valueKind) : null;
    for (const replyType of listeners) this.deliver(replyType, value);
  }
  outputValue(outputIndex, bytes) {
    const output = this.outputs[outputIndex];
    const listeners = this.outputListeners.get(output?.id);
    if (!output || !listeners?.size) return;
    const value = unpack(bytes, output.layout, output.valueKind);
    for (const replyType of listeners) this.deliver(replyType, value);
  }

  sendMessageToServer(msg) {
    switch (msg.type) {
      case 'req_status':
        this.deliver('status', { manifest: this.manifest, details: { inputs: this.inputs, outputs: this.outputs }, sampleRate: 0, host: 'WCLAP' });
        break;
      case 'send_value': this.sendValue(msg.id, msg.value); break;
      case 'req_param_value': {
        const value = this.values.get(msg.id);
        if (value !== undefined) this.deliver('param_value', { endpointID: msg.id, value });
        break;
      }
      case 'req_reset':
        for (const parameter of this.parameters) this.sendValue(parameter.id, initialValue(parameter));
        break;
      case 'send_gesture_start': case 'send_gesture_end': {
        const index = this.parameterIndex.get(msg.id);
        if (index !== undefined) this.sendToPlugin({ t: 'gesture', i: index, begin: msg.type === 'send_gesture_start' });
        break;
      }
      case 'req_state_value':
        this.deliver('state_key_value', { key: msg.key, value: this.storedState.get(msg.key) });
        break;
      case 'send_state_value':
        if (msg.value === undefined || msg.value === null) this.storedState.delete(msg.key);
        else this.storedState.set(msg.key, msg.value);
        this.sendToPlugin({ t: 'state', k: msg.key, v: msg.value ?? null });
        this.deliver('state_key_value', { key: msg.key, value: msg.value });
        break;
      case 'clear_all_state_values':
        this.storedState.clear();
        this.sendToPlugin({ t: 'stateClear' });
        break;
      case 'req_full_state':
        this.deliver(msg.replyType, { parameters: [...this.values].map(([name, value]) => ({ name, value })), values: Object.fromEntries(this.storedState) });
        break;
      case 'send_full_state': {
        for (const { name, value } of Array.isArray(msg.value?.parameters) ? msg.value.parameters : [])
          if (this.parameterIndex.has(name)) this.sendValue(name, value);
        this.sendToPlugin({ t: 'stateClear' });
        this.storedState = new Map(Object.entries(msg.value?.values ?? {}));
        for (const [key, value] of this.storedState) { this.sendToPlugin({ t: 'state', k: key, v: value }); this.deliver('state_key_value', { key, value }); }
        break;
      }
      case 'add_endpoint_listener': {
        if (!this.outputListeners.has(msg.endpoint)) this.outputListeners.set(msg.endpoint, new Set());
        this.outputListeners.get(msg.endpoint).add(msg.replyType);
        break;
      }
      case 'remove_endpoint_listener':
        this.outputListeners.get(msg.endpoint)?.delete(msg.replyType);
        break;
      default: break;
    }
  }

  sendValue(endpointID, value) {
    const parameterIndex = this.parameterIndex.get(endpointID);
    if (parameterIndex !== undefined) {
      const number = Number(value);
      if (!Number.isFinite(number)) return;
      this.values.set(endpointID, number);
      this.sendToPlugin({ t: 'param', i: parameterIndex, v: number });
      this.deliver('param_value', { endpointID, value: number });
      return;
    }
    const inputIndex = this.inputIndex.get(endpointID);
    const input = this.inputs[inputIndex];
    if (!input) return;
    if (input.purpose === 'midi in') {
      const message = typeof value === 'object' && value !== null ? value.message : value;
      if (Number.isInteger(Number(message))) this.sendToPlugin({ t: 'midi', m: Number(message) });
      return;
    }
    if (input.kind === 'event' && input.events?.length) {
      const handler = input.events.find((event) => matchesLayout(value, event)) ?? input.events[0];
      this.sendToPlugin({ t: 'event', e: inputIndex, k: handler.typeIndex, b: pack(value, handler.layout, handler.valueKind) });
    } else if (input.kind === 'value') {
      this.sendToPlugin({ t: 'value', e: inputIndex, b: pack(value, input.layout, input.valueKind) });
    }
  }

  deliver(type, message) { queueMicrotask(() => this.deliverMessageFromServer({ type, message })); }
}

function initialValue(parameter) {
  const { min, init } = parameter.annotation ?? {};
  const value = Number(init ?? min ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function matchesLayout(value, event) {
  if (!event.layout?.length) return typeof value !== 'object' || value === null;
  if (typeof value !== 'object' || value === null) return false;
  return event.layout.every((field) => field.path === '' || getPath(value, field.path) !== undefined);
}

// ---- value packing against the compiler-reported layouts ----

const fieldSize = { int32: 4, float32: 4, string: 4, int64: 8, float64: 8, bool: 1 };

export function pack(value, layout, valueKind) {
  if (!layout?.length) return packPrimitive(value, valueKind);
  let size = 0;
  for (const field of layout) size = Math.max(size, field.kind === 'bool' ? (field.bit >> 3) + 1 : field.offset + fieldSize[field.kind]);
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  for (const field of layout) {
    const v = field.path === '' ? value : getPath(value, field.path);
    switch (field.kind) {
      case 'int32': view.setInt32(field.offset, Math.trunc(Number(v) || 0), true); break;
      case 'int64': view.setBigInt64(field.offset, BigInt(Math.trunc(Number(v) || 0)), true); break;
      case 'float32': view.setFloat32(field.offset, Number(v) || 0, true); break;
      case 'float64': view.setFloat64(field.offset, Number(v) || 0, true); break;
      case 'bool': if (v) bytes[field.bit >> 3] |= 1 << (field.bit & 7); break;
      default: break;
    }
  }
  return bytes;
}

function packPrimitive(value, valueKind) {
  const bytes = new Uint8Array(valueKind === 'float64' || valueKind === 'int64' ? 8 : 4);
  const view = new DataView(bytes.buffer);
  const number = typeof value === 'object' && value !== null ? Number(Object.values(value)[0]) : Number(value);
  if (valueKind === 'float64') view.setFloat64(0, number || 0, true);
  else if (valueKind === 'int64') view.setBigInt64(0, BigInt(Math.trunc(number) || 0), true);
  else if (valueKind === 'int32') view.setInt32(0, Math.trunc(number) || 0, true);
  else if (valueKind === 'bool') view.setInt32(0, number ? 1 : 0, true);
  else view.setFloat32(0, number || 0, true);
  return bytes;
}

export function unpack(bytes, layout, valueKind) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const read = (field, offset) => {
    switch (field.kind) {
      case 'int32': return view.getInt32(offset, true);
      case 'int64': return Number(view.getBigInt64(offset, true));
      case 'float32': return view.getFloat32(offset, true);
      case 'float64': return view.getFloat64(offset, true);
      case 'bool': return Boolean(bytes[field.bit >> 3] & (1 << (field.bit & 7)));
      case 'string': return view.getInt32(offset, true);
      default: return null;
    }
  };
  if (!layout?.length) {
    if (valueKind === 'void' || bytes.byteLength === 0) return null;
    return read({ kind: valueKind === 'bool' ? 'int32' : valueKind }, 0);
  }
  if (layout.length === 1 && layout[0].path === '') return read(layout[0], layout[0].offset);
  const result = {};
  for (const field of layout) setPath(result, field.path, read(field, field.offset));
  return result;
}

function pathParts(path) { return path.match(/\.[\w$]+|\[\d+\]/g)?.map((part) => (part[0] === '.' ? part.slice(1) : Number(part.slice(1, -1)))) ?? []; }
function getPath(object, path) { let current = object; for (const part of pathParts(path)) { if (current === null || current === undefined) return undefined; current = current[part]; } return current; }
function setPath(object, path, value) {
  const parts = pathParts(path);
  let current = object;
  parts.forEach((part, index) => {
    if (index === parts.length - 1) current[part] = value;
    else { if (current[part] === undefined) current[part] = typeof parts[index + 1] === 'number' ? [] : {}; current = current[part]; }
  });
}

function normalisePath(path) {
  const parts = [];
  for (const part of String(path).replaceAll('\\', '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}

/**
 * Mounts the patch's own view when it declares one (and `type` is not 'generic'),
 * otherwise Cmajor's generic view. Resolves to what was mounted and its natural size.
 */
export async function mountPatchView(container, connection, type = 'custom') {
  container.replaceChildren();
  const view = connection.manifest?.view;
  let result = { type: 'generic', width: 500, height: 400 };
  let element;
  if (type !== 'generic' && view?.src) {
    try {
      const viewModule = await import(connection.getResourceAddress(view.src));
      const custom = await viewModule?.default?.(connection);
      if (!custom) throw new Error('The view module returned nothing');
      custom.style.display = 'block';
      const fixed = view.width > 10 && view.height > 10;
      const limits = custom.getScaleFactorLimits?.();
      const width = fixed ? view.width : 500, height = fixed ? view.height : 400;
      element = document.createElement('div');
      element.className = 'cmaj-scaled-view';
      element.style.cssText = 'display:block;width:100%;height:100%;position:relative;overflow:hidden;';
      if (fixed) {
        // A fixed-size view: scale it to fill the window, keeping its aspect ratio (like the
        // native Cmajor plug-in). Views may bound the scale with getScaleFactorLimits().
        custom.style.width = `${width}px`;
        custom.style.height = `${height}px`;
        custom.style.position = 'absolute';
        custom.style.transformOrigin = '0 0';
        const fit = () => {
          const w = element.clientWidth, h = element.clientHeight;
          if (!w || !h) return;
          let scale = Math.min(w / width, h / height);
          if (limits?.minScale) scale = Math.max(scale, limits.minScale);
          if (limits?.maxScale) scale = Math.min(scale, limits.maxScale);
          custom.style.transform = `scale(${scale})`;
          custom.style.left = `${Math.round((w - width * scale) / 2)}px`;
          custom.style.top = `${Math.round((h - height * scale) / 2)}px`;
        };
        element.appendChild(custom);
        new ResizeObserver(fit).observe(element);
        fit();
      } else {
        // A responsive view lays itself out: give it the whole window.
        custom.style.width = '100%';
        custom.style.height = '100%';
        element.appendChild(custom);
      }
      result = { type: 'custom', width, height, lockAspect: fixed && !limits };
    } catch (error) {
      console.warn('Patch view failed, using the generic view', error);
      result.error = error;
    }
  }
  if (!element) element = await createPatchViewHolder(connection, 'generic');
  if (element) container.appendChild(element);
  connection.requestStatusUpdate();
  return result;
}

/** Runs the patch's worker script (manifest "worker") against the connection, as native hosts do. */
export async function startPatchWorker(connection) {
  const worker = connection.manifest?.worker;
  if (!worker || connection.workerStarted) return false;
  connection.workerStarted = true;
  const module = await import(connection.getResourceAddress(String(worker)));
  await module?.default?.(connection);
  return true;
}
