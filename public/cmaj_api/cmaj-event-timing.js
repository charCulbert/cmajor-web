// Adapted from charCulbert/wclap-web-audio event-transport.mjs (MIT),
// revision 2ca89137fbaed6fe0e6db21525de996e8783654b.
const RENDER_QUANTUM_FRAMES = 128;
const SILENT_CLOCK_STALL_SECONDS = 0.25;
const timestampAnchors = new WeakMap();
const timestampEpochs = new WeakMap();

function timestampEpoch(audioContext) {
    if (typeof audioContext.startRendering === "function") return 0;
    let epoch = timestampEpochs.get(audioContext);
    if (!epoch) {
        epoch = { value: 0 };
        timestampEpochs.set(audioContext, epoch);
        audioContext.addEventListener?.("statechange", () => ++epoch.value);
    }
    return epoch.value;
}

export function eventFrameFromTimestamp(audioContext, timestamp = performance.now(), receivedAt = performance.now()) {
    if (!Number.isFinite(timestamp) || (timestamp === 0 && receivedAt > 1000)) timestamp = receivedAt;
    const sampleRate = Number(audioContext.sampleRate);
    const currentFrame = Math.max(0, Math.round(Number(audioContext.currentTime) * sampleRate));
    const epoch = timestampEpoch(audioContext);
    let anchor = timestampAnchors.get(audioContext);
    const offline = typeof audioContext.startRendering === "function";
    const baseLatencyFrames = Number(audioContext.baseLatency) * sampleRate;
    const bufferFrames = Number.isFinite(baseLatencyFrames)
        ? Math.max(RENDER_QUANTUM_FRAMES, Math.ceil(Math.max(0, baseLatencyFrames)))
        : RENDER_QUANTUM_FRAMES;
    const observedDrift = anchor && !offline
        ? currentFrame - anchor.observedFrame - Math.round((receivedAt - anchor.observedAt) * sampleRate / 1000)
        : 0;
    const stalled = !offline && audioContext.state === "running"
        && observedDrift < -Math.max(sampleRate * SILENT_CLOCK_STALL_SECONDS, bufferFrames * 4);

    if (!anchor || anchor.sampleRate !== sampleRate || anchor.epoch !== epoch || stalled) {
        const nextRenderBoundary = Math.ceil((currentFrame + 1) / RENDER_QUANTUM_FRAMES) * RENDER_QUANTUM_FRAMES;
        anchor = {
            timestamp,
            frame: nextRenderBoundary,
            sampleRate,
            receivedAt,
            epoch,
            observedFrame: currentFrame,
            observedAt: receivedAt,
            nominalLead: nextRenderBoundary - currentFrame,
            latestTimestamp: timestamp,
            latestFrame: nextRenderBoundary,
        };
        timestampAnchors.set(audioContext, anchor);
    } else if (!offline && audioContext.state === "running") {
        const projectedNow = anchor.frame + Math.round((receivedAt - anchor.receivedAt) * sampleRate / 1000);
        const correctedNow = Math.max(currentFrame + anchor.nominalLead - bufferFrames,
            Math.min(currentFrame + anchor.nominalLead + bufferFrames, projectedNow));
        anchor.frame += correctedNow - projectedNow;
    }

    anchor.observedFrame = currentFrame;
    anchor.observedAt = receivedAt;
    let frame = Math.max(0, anchor.frame + Math.round((timestamp - anchor.timestamp) * sampleRate / 1000));
    if (timestamp >= anchor.latestTimestamp) {
        frame = Math.max(frame, anchor.latestFrame);
        anchor.latestTimestamp = timestamp;
        anchor.latestFrame = frame;
    }
    return frame;
}
