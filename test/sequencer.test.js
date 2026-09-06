import assert from "node:assert/strict";
import test from "node:test";
import { allNotesOffMessages, packMIDI, sequenceEventsInWindow } from "../src/sequencer.js";

const notes = [
  { id: "a", note: 60, start: 0, duration: 1, velocity: 100, channel: 2 },
  { id: "b", note: 64, start: 1, duration: 0.5, velocity: 90, channel: 0 },
];

test("packs channel MIDI messages in Cmajor short-message order", () => {
  assert.equal(packMIDI(0x90, 60, 100, 2), 0x923c64);
  assert.equal(packMIDI(0x80, 60, 0, 2), 0x823c00);
});

test("converts beat positions to precise repeating timestamps", () => {
  const events = sequenceEventsInWindow(notes, { from: 1000, to: 3100, startedAt: 1000, bpm: 120, beats: 4 });
  assert.deepEqual(events.map(({ timestamp, message }) => [timestamp, message]), [
    [1000, 0x923c64],
    [1500, 0x823c00],
    [1500, 0x90405a],
    [1750, 0x804000],
    [3000, 0x923c64],
  ]);
});

test("half-open lookahead windows neither duplicate nor reorder boundary events", () => {
  const options = { startedAt: 1000, bpm: 120, beats: 4 };
  const first = sequenceEventsInWindow(notes, { ...options, from: 1000, to: 1500 });
  const second = sequenceEventsInWindow(notes, { ...options, from: 1500, to: 2000 });
  assert.equal(first.length, 1);
  assert.deepEqual(second.map(({ timestamp, priority }) => [timestamp, priority]), [[1500, 0], [1500, 1], [1750, 0]]);
});

test("transport cleanup sends all-notes-off on every MIDI channel", () => {
  const messages = allNotesOffMessages();
  assert.equal(messages.length, 16);
  assert.deepEqual(messages, Array.from({ length: 16 }, (_, channel) => 0xb07b00 | (channel << 16)));
});

test("rejects invalid transport ranges", () => {
  assert.deepEqual(sequenceEventsInWindow(notes, { from: 1, to: 2, startedAt: 0, bpm: 0, beats: 4 }), []);
});
