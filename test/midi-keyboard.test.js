import assert from "node:assert/strict";
import test from "node:test";
import { isWhiteKey, normaliseKeyboardRange, whiteKeyBoundary } from "../src/midi-keyboard.js";

test("keyboard boundaries snap to white keys", () => {
  assert.equal(whiteKeyBoundary(49), 48);
  assert.equal(whiteKeyBoundary(51), 50);
  assert.equal(whiteKeyBoundary(54), 53);
  assert.equal(isWhiteKey(48), true);
  assert.equal(isWhiteKey(49), false);
});

test("keyboard ranges normalise saved black-key boundaries", () => {
  const range = normaliseKeyboardRange(49, 37);
  assert.deepEqual(range, { root: 48, count: 37 });
  assert.equal(isWhiteKey(range.root), true);
  assert.equal(isWhiteKey(range.root + range.count - 1), true);
});

test("keyboard ranges retain their fixed white edge while resizing", () => {
  assert.deepEqual(normaliseKeyboardRange(48, 38), { root: 48, count: 37 });
  assert.deepEqual(normaliseKeyboardRange(49, 36), { root: 48, count: 37 });
});

test("keyboard ranges stay within MIDI and size bounds", () => {
  assert.deepEqual(normaliseKeyboardRange(-20, 2), { root: 0, count: 13 });
  const high = normaliseKeyboardRange(126, 200);
  assert.equal(high.root, 113);
  assert.equal(high.root + high.count - 1, 127);
});
