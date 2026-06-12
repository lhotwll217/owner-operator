// Owner Operator — THE canonical thread-state resolver. One rule, in one place, that every
// surface goes through: raw transcript scans produce CANDIDATE facts; the persisted status
// store holds OPERATOR state (`done`); this module joins the two.
//
// Modeled on OpenClaw's state ownership (docs/inspiration.md): a single owner of session
// state, surfaces query it rather than derive their own. Until a gateway process owns this
// boundary, the shared module is the boundary — plain dependency-free ESM (not TS) so the
// exact same code runs in the TS harness (re-exported via @owner-operator/core) AND inside
// the zero-install scan skill. Types live in resolve.d.mts; keep it in lockstep.

/** Quiet at least this long → `idle`, regardless of who spoke last. Lo-fi; tune later. */
export const IDLE_AFTER_SECONDS = 30 * 60;

/**
 * Derive a candidate's state from raw scan facts — no model, no store. A turn still in
 * progress (reasoning / running tools / streaming) → `working`, even if the last message
 * is the assistant's — the `working` flag is what stops a thinking agent from looking
 * "stopped", so it wins. Then quiet too long → `idle` — by MESSAGE time, never file
 * activity: GUI apps append housekeeping events (mode/meta lines) that keep the file's
 * mtime forever fresh, which made 8-hour-old threads read "2m ago" and never idle.
 * Otherwise: assistant spoke last and yielded → `needs-you`; user spoke last → `working`.
 */
export function deriveState(row) {
  if (row.working) return "working";
  if (row.secondsSinceLastMessage >= IDLE_AFTER_SECONDS) return "idle";
  return row.lastRole === "assistant" ? "needs-you" : "working";
}

/**
 * Does an operator-set `done` still hold for this candidate? `done` is durable operator
 * state — transcripts can't observe "resolved" — so it survives every rescan until a NEWER
 * message lands, which wakes the thread. ISO-Z timestamps compare lexicographically.
 */
export function holdsDone(persisted, candidate) {
  return persisted?.state === "done" && candidate.lastMessageAt <= persisted.lastMessageAt;
}

/** Resolve one candidate against its persisted thread — the per-thread entry point. */
export function resolveState(persisted, candidate) {
  return holdsDone(persisted, candidate) ? "done" : deriveState(candidate);
}

/** Visibility on active surfaces: resolved `done` rows leave by default. */
export function isActiveState(state) {
  return state !== "done";
}

/**
 * Join scan candidates with the persisted threads (by id): annotate every row with its
 * resolved `state`, and — unless `includeDone` (the audit opt-in) — drop rows still held
 * done. Pure: returns copies, inputs untouched.
 */
export function resolveCandidates(candidates, persisted, { includeDone = false } = {}) {
  const byId = new Map((persisted ?? []).map((t) => [t.id, t]));
  const resolved = candidates.map((c) => ({ ...c, state: resolveState(byId.get(c.id), c) }));
  return includeDone ? resolved : resolved.filter((c) => isActiveState(c.state));
}
