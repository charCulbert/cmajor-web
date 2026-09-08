// The plug-in's webview: shows the linked patch's own GUI (or Cmajor's generic view) and
// bridges its PatchConnection to the plug-in over CBOR messages.
import { encode, decode } from './cbor.js';
import { LoaderPatchConnection, mountPatchView, startPatchWorker } from './patch-ui.js';

// WCLAP hosts copy UI messages through a small fixed arena (16 KiB in wclap-host-js),
// so anything larger is delivered as a sequence of framed chunks the plug-in reassembles.
const chunkMagic = 0x434a4d43;
const chunkPayload = 8192 - 12;
const pollIntervalMs = 33;

function postToPlugin(bytes) {
  if (bytes.byteLength <= chunkPayload + 12) { window.parent.postMessage(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '*'); return; }
  for (let offset = 0; offset < bytes.byteLength; offset += chunkPayload) {
    const payload = bytes.subarray(offset, Math.min(offset + chunkPayload, bytes.byteLength));
    const frame = new ArrayBuffer(12 + payload.byteLength);
    const view = new DataView(frame);
    view.setUint32(0, chunkMagic, true); view.setUint32(4, bytes.byteLength, true); view.setUint32(8, offset, true);
    new Uint8Array(frame, 12).set(payload);
    window.parent.postMessage(frame, '*');
  }
}
const send = (message) => postToPlugin(encode(message));

const strip = document.querySelector('#strip');
const status = document.querySelector('#status');
const viewContainer = document.querySelector('#view');
let connection;
let pollTimer;

addEventListener('message', ({ data }) => {
  if (!(data instanceof ArrayBuffer)) return;
  let message;
  try { message = decode(new Uint8Array(data)); } catch { return; }
  if (!message || typeof message !== 'object') return;
  switch (message.t) {
    case 'session': presentSession(message).catch(reportError); break;
    case 'pending': applyPending(message); break;
    default: break;
  }
});

/** The plug-in's answer to "ready", and its announcement after a state load. */
async function presentSession(session) {
  stopPolling();
  connection = undefined;
  if (!session.running) {
    viewContainer.replaceChildren();
    viewContainer.hidden = true;
    showError(session.error || 'The patch could not be started');
    return;
  }
  const meta = decode(session.metadata);
  connection = new LoaderPatchConnection(meta, send, { params: session.params, stored: session.stored });
  viewContainer.hidden = false;
  strip.hidden = true;
  startPatchWorker(connection).catch((error) => showError(`The patch worker failed: ${error.message}`));
  const mounted = await mountPatchView(viewContainer, connection, 'custom');
  if (mounted.error) showError(`The patch GUI could not be loaded (${mounted.error.message}); showing the generic view`);
  // The view's own scale limits (the ones cmaj_api scales by) become the window's size limits,
  // so the host cannot shrink the window to where the view would be cut off.
  if (mounted.type === 'custom') {
    const limits = viewContainer.querySelector('cmaj-patch-view-holder')?.view?.getScaleFactorLimits?.() ?? {};
    send({ t: 'limits', w: mounted.width, h: mounted.height, min: Number(limits.minScale) || 1, max: Number(limits.maxScale) || 0 });
  }
  pollTimer = setInterval(() => send({ t: 'poll' }), pollIntervalMs);
}

function stopPolling() { clearInterval(pollTimer); pollTimer = undefined; }

function applyPending(message) {
  if (!connection) return;
  for (const [index, value] of message.params ?? []) connection.parameterChanged(index, value);
  for (const event of message.events ?? []) connection.outputEvent(event.e, event.f, event.k, event.b);
  for (const value of message.values ?? []) connection.outputValue(value.e, value.b);
}

function reportError(error) { showError(error instanceof Error ? error.message : String(error)); }
function showError(message) { strip.hidden = false; status.textContent = message; status.classList.add('error'); }

send({ t: 'ready' });
