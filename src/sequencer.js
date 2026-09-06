export const DEFAULT_SEQUENCE_NOTES = Object.freeze([
  { id: "tumbao-1", note: 36, start: 0, duration: 0.6, velocity: 112, channel: 0 },
  { id: "tumbao-2", note: 43, start: 1.5, duration: 0.4, velocity: 102, channel: 0 },
  { id: "tumbao-3", note: 36, start: 2, duration: 0.6, velocity: 108, channel: 0 },
  { id: "tumbao-4", note: 43, start: 3.5, duration: 0.4, velocity: 104, channel: 0 },
  { id: "montuno-1", note: 60, start: 0, duration: 0.3, velocity: 104, channel: 0 },
  { id: "montuno-2", note: 63, start: 0, duration: 0.3, velocity: 96, channel: 0 },
  { id: "montuno-3", note: 55, start: 0.75, duration: 0.4, velocity: 88, channel: 0 },
  { id: "montuno-4", note: 60, start: 0.75, duration: 0.4, velocity: 94, channel: 0 },
  { id: "montuno-5", note: 63, start: 1.5, duration: 0.35, velocity: 98, channel: 0 },
  { id: "montuno-6", note: 67, start: 1.5, duration: 0.35, velocity: 108, channel: 0 },
  { id: "montuno-7", note: 60, start: 2, duration: 0.3, velocity: 102, channel: 0 },
  { id: "montuno-8", note: 63, start: 2, duration: 0.3, velocity: 94, channel: 0 },
  { id: "montuno-9", note: 55, start: 2.75, duration: 0.4, velocity: 86, channel: 0 },
  { id: "montuno-10", note: 60, start: 2.75, duration: 0.4, velocity: 92, channel: 0 },
  { id: "montuno-11", note: 63, start: 3.5, duration: 0.4, velocity: 100, channel: 0 },
  { id: "montuno-12", note: 67, start: 3.5, duration: 0.4, velocity: 110, channel: 0 },
]);

export function packMIDI(status, note, velocity = 0, channel = 0) {
  return ((status | (channel & 0x0f)) << 16) | ((note & 0x7f) << 8) | (velocity & 0x7f);
}

export function allNotesOffMessages() {
  return Array.from({ length: 16 }, (_, channel) => packMIDI(0xb0, 123, 0, channel));
}

export function sequenceEventsInWindow(notes, {
  from,
  to,
  startedAt,
  bpm,
  beats = 4,
} = {}) {
  if (![from, to, startedAt, bpm, beats].every(Number.isFinite) || to <= from || bpm <= 0 || beats <= 0) return [];
  const millisecondsPerBeat = 60000 / bpm;
  const cycleDuration = beats * millisecondsPerBeat;
  const firstCycle = Math.floor((from - startedAt) / cycleDuration) - 1;
  const lastCycle = Math.floor((to - startedAt) / cycleDuration);
  const events = [];

  for (let cycle = Math.max(0, firstCycle); cycle <= lastCycle; ++cycle) {
    const cycleStart = startedAt + cycle * cycleDuration;
    for (const note of notes) {
      const channel = Number(note.channel) || 0;
      const pitch = Number(note.note);
      const velocity = Number(note.velocity) || 1;
      const on = cycleStart + Number(note.start) * millisecondsPerBeat;
      const off = on + Number(note.duration) * millisecondsPerBeat;
      if (off >= from && off < to) events.push({ timestamp: off, priority: 0, message: packMIDI(0x80, pitch, 0, channel) });
      if (on >= from && on < to) events.push({ timestamp: on, priority: 1, message: packMIDI(0x90, pitch, velocity, channel) });
    }
  }

  return events.sort((a, b) => a.timestamp - b.timestamp || a.priority - b.priority);
}
