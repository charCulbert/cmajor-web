import assert from "node:assert/strict";
import test from "node:test";
import {
  createMeterChannel,
  levelToDB,
  METER_MIN_DB,
  setChannelMinMax,
} from "../src/metering.js";

test("meter uses the absolute peak from signed min/max samples", () => {
  const channel = createMeterChannel(0);
  setChannelMinMax(channel, -0.5, 0.25, 10);
  assert.equal(channel.currentLevel, 20 * Math.log10(0.5));
  assert.equal(levelToDB(0), METER_MIN_DB);
});

test("meter replaces its level with the latest 400-sample peak", () => {
  const channel = createMeterChannel(0);
  setChannelMinMax(channel, -1, 0.5, 0);
  assert.equal(channel.currentLevel, 0);
  setChannelMinMax(channel, -0.5, 0.25, 10);
  assert.equal(channel.currentLevel, 20 * Math.log10(0.5));
});
