import assert from "node:assert/strict";
import test from "node:test";
import { eventFrameFromTimestamp } from "../public/cmaj_api/cmaj-event-timing.js";

function context({ bufferFrames = 128, offline = false } = {}) {
  const listeners = new Set();
  return {
    sampleRate: 48000,
    currentTime: 0,
    state: "running",
    baseLatency: bufferFrames / 48000,
    addEventListener(type, listener) { if (type === "statechange") listeners.add(listener); },
    setState(state) { this.state = state; for (const listener of listeners) listener(); },
    ...(offline ? { startRendering: async () => {} } : {}),
  };
}

test("maps timestamp spacing to exact AudioContext frames", () => {
  const audioContext = context();
  audioContext.currentTime = 2;
  assert.equal(eventFrameFromTimestamp(audioContext, 1002.5, 1003), 96128);
  assert.equal(eventFrameFromTimestamp(audioContext, 1002.5 + 50 / 48, 1003), 96178);
  assert.equal(eventFrameFromTimestamp(audioContext, 1002.5 + 100 / 48, 1003), 96228);
});

test("preserves exact spacing across stepped realtime context clocks", () => {
  for (const bufferFrames of [128, 256, 512, 1024, 4096]) {
    for (const gapFrames of [48, 96, 240]) {
      for (const phase of [0, Math.floor(bufferFrames / 3), bufferFrames - 1]) {
        const audioContext = context({ bufferFrames });
        audioContext.currentTime = Math.floor(phase / bufferFrames) * bufferFrames / 48000;
        const first = eventFrameFromTimestamp(audioContext, 1000, 1007);
        for (let index = 1; index <= 200; ++index) {
          const elapsed = index * gapFrames;
          audioContext.currentTime = Math.floor((phase + elapsed) / bufferFrames) * bufferFrames / 48000;
          const sourceTime = 1000 + elapsed / 48;
          assert.equal(eventFrameFromTimestamp(audioContext, sourceTime, sourceTime + 7), first + elapsed);
        }
      }
    }
  }
});

test("does not invert events at a stepped-clock boundary or clamp future timestamps", () => {
  const audioContext = context({ bufferFrames: 512 });
  audioContext.currentTime = 45056 / 48000;
  assert.deepEqual([
    eventFrameFromTimestamp(audioContext, 1000, 1000),
    eventFrameFromTimestamp(audioContext, 1002.6, 1002.6),
    eventFrameFromTimestamp(audioContext, 1002.8, 1002.8),
  ], [45184, 45309, 45318]);

  const futureContext = context({ bufferFrames: 512 });
  const first = eventFrameFromTimestamp(futureContext, 1000, 1000);
  assert.equal(eventFrameFromTimestamp(futureContext, 2000, 1001), first + 48000);
});

test("starts a new precise epoch after suspend and resume", () => {
  const audioContext = context({ bufferFrames: 512 });
  assert.equal(eventFrameFromTimestamp(audioContext, 1000, 1000), 128);
  audioContext.currentTime = 1;
  audioContext.setState("suspended");
  audioContext.setState("running");
  const resumed = eventFrameFromTimestamp(audioContext, 6000, 6000);
  assert.equal(resumed, 48128);
  for (let index = 1; index <= 4; ++index) {
    assert.equal(eventFrameFromTimestamp(audioContext, 6000 + index * 10, 6000), resumed + index * 480);
  }
});

test("recovers from a silent clock stall and preserves suspended spacing", () => {
  const stalled = context({ bufferFrames: 512 });
  stalled.currentTime = 2;
  assert.equal(eventFrameFromTimestamp(stalled, 1000, 1000), 96128);
  stalled.currentTime = 3;
  assert.equal(eventFrameFromTimestamp(stalled, 2000, 2000), 144128);
  assert.equal(eventFrameFromTimestamp(stalled, 7000, 7000), 144128);
  assert.equal(eventFrameFromTimestamp(stalled, 7000 + 50 / 48, 7000), 144178);

  const suspended = context({ bufferFrames: 512 });
  suspended.currentTime = 5;
  eventFrameFromTimestamp(suspended, 1000, 1000);
  suspended.setState("suspended");
  const frames = Array.from({ length: 5 }, (_, index) =>
    eventFrameFromTimestamp(suspended, 2000 + index * 100, 2000 + index * 100));
  assert.deepEqual(frames.map((frame) => frame - frames[0]), [0, 4800, 9600, 14400, 19200]);
});

test("keeps anchors context-local and resets after a sample-rate change", () => {
  const first = context();
  const second = context();
  first.currentTime = 1;
  second.currentTime = 3;
  assert.equal(eventFrameFromTimestamp(first, 1000, 1000), 48128);
  assert.equal(eventFrameFromTimestamp(second, 1000, 1000), 144128);
  first.sampleRate = 96000;
  first.currentTime = 2;
  assert.equal(eventFrameFromTimestamp(first, 2000, 2000), 192128);
});

test("offline timestamp conversion is independent of render pacing", () => {
  const render = (pacing) => {
    const audioContext = context({ offline: true });
    return pacing.map((currentTime, index) => {
      audioContext.currentTime = currentTime;
      return eventFrameFromTimestamp(audioContext, 5000 + index * 10, 5000 + index);
    });
  };
  assert.deepEqual(render([0, 0.1, 0.2, 0.3]), render([0, 1, 4, 9]));
  const frames = render([0, 0.1, 0.2, 0.3]);
  assert.deepEqual(frames.map((frame) => frame - frames[0]), [0, 480, 960, 1440]);
});

test("keeps live timestamps ordered while bounding long-term skew", () => {
  const bufferFrames = 512;
  const audioContext = context({ bufferFrames });
  let previous = eventFrameFromTimestamp(audioContext, 1000, 1000);
  for (let index = 1; index <= 12000; ++index) {
    const elapsed = index * 4800;
    const audioFrames = Math.floor(elapsed * 1.0001 / bufferFrames) * bufferFrames;
    audioContext.currentTime = audioFrames / 48000;
    const frame = eventFrameFromTimestamp(audioContext, 1000 + index * 100, 1000 + index * 100);
    assert.ok(frame >= previous);
    assert.ok(frame - audioFrames >= 128 - bufferFrames && frame - audioFrames <= 128 + bufferFrames);
    previous = frame;
  }
});
