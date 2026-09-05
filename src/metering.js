export const METER_MIN_DB = -90;
export const METER_MAX_DB = 6;

export function createMeterChannel() {
  return { currentLevel: METER_MIN_DB };
}

export function levelToDB(level) {
  return level > 0 ? Math.max(METER_MIN_DB, Math.min(METER_MAX_DB, 20 * Math.log10(level))) : METER_MIN_DB;
}

export function setChannelMinMax(channel, minSample, maxSample) {
  const level = Math.max(Math.abs(minSample), Math.abs(maxSample));
  channel.currentLevel = levelToDB(level);
}
