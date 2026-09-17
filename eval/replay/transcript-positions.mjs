// Replay one captured conversation as it grew, rather than only as it ended.
//
// A capture holds each transcript's final state. The status summary's history, the title's
// stability, and the reassessment cadence are all about what happens between positions, so a
// replay that only ever sees the last line cannot exercise them. These helpers cut a transcript
// at a conversational position and land that position on the current clock, so the daemon
// observes a session that has just reached it.

const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/;
const TIMESTAMP_FIELD = new RegExp(`("timestamp"\\s*:\\s*")(${ISO.source})(")`, "g");

/** Line indexes that carry a conversation turn, in file order. */
export function conversationalLines(lines) {
  return lines.flatMap((line, index) => {
    let parsed;
    try { parsed = JSON.parse(line); } catch { return []; }
    const kind = parsed.payload?.type ?? parsed.type;
    return parsed.message || kind === "message" || kind === "user" || kind === "assistant" ? [index] : [];
  });
}

export function lastTimestamp(lines) {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    TIMESTAMP_FIELD.lastIndex = 0;
    const match = TIMESTAMP_FIELD.exec(lines[index]);
    if (match) return Date.parse(match[2]);
  }
  return null;
}

/** Rewrite a conversation so its final message lands on `targetMs`, keeping every gap. */
export function shiftTo(lines, targetMs) {
  const last = lastTimestamp(lines);
  if (last === null) return [...lines];
  const delta = targetMs - last;
  return lines.map((line) => line.replace(TIMESTAMP_FIELD, (_match, open, value, close) =>
    `${open}${new Date(Date.parse(value) + delta).toISOString()}${close}`));
}

/**
 * The conversation as it stood at `position` of `positions`, including the non-conversational
 * lines each kept turn needs to parse. The last position is the whole file.
 */
export function prefixAt(lines, position, positions) {
  const turns = conversationalLines(lines);
  if (!turns.length || position >= positions) return [...lines];
  const wanted = Math.max(2, Math.ceil((turns.length * position) / positions));
  return lines.slice(0, turns[Math.min(wanted, turns.length) - 1] + 1);
}
