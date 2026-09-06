const WHITE_PITCH_CLASSES = new Set([0, 2, 4, 5, 7, 9, 11]);

export function isWhiteKey(note) {
  return WHITE_PITCH_CLASSES.has(((Math.round(note) % 12) + 12) % 12);
}

export function whiteKeyBoundary(note, min = 0, max = 127) {
  const candidate = Math.min(max, Math.max(min, Math.round(note)));
  for (let distance = 0; distance < 12; ++distance) {
    const lower = candidate - distance;
    if (lower >= min && isWhiteKey(lower)) return lower;
    const upper = candidate + distance;
    if (upper <= max && isWhiteKey(upper)) return upper;
  }
  return candidate;
}

export function normaliseKeyboardRange(root, count) {
  const requestedCount = Math.min(81, Math.max(13, Math.round(Number(count) || 37)));
  const requestedTop = Math.round(Number(root) || 0) + requestedCount - 1;
  const snappedRoot = whiteKeyBoundary(root, 0, 114);
  const top = whiteKeyBoundary(requestedTop, snappedRoot + 12, Math.min(127, snappedRoot + 80));
  return { root: snappedRoot, count: top - snappedRoot + 1 };
}
