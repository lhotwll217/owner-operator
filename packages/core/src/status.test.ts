// Deterministic test of the state machine — pure functions, no model, no I/O.
//   npm test   (from packages/core/)
// Covers state derivation, continuity (firstSeen/stateSince), diff, and attention sort.

import assert from "node:assert";
import {
  deriveState,
  reconcile,
  diffSnapshots,
  sortByAttention,
  formatRelative,
  cleanTopic,
  becameNeedsYou,
  IDLE_AFTER_SECONDS,
  type ScanRow,
  type StatusSnapshot,
} from "./status";

const row = (over: Partial<ScanRow> & Pick<ScanRow, "id">): ScanRow => ({
  source: "claude", repo: "demo", app: "Claude Code", topic: "t",
  lastRole: "assistant", createdAt: "2026-06-09T10:00:00.000Z",
  lastMessageAt: "2026-06-09T10:05:00.000Z", secondsSinceLastMessage: 60, ...over,
});

// --- deriveState ---
assert.equal(deriveState({ lastRole: "assistant", secondsSinceLastMessage: 60 }), "needs-you", "assistant spoke last → needs-you");
assert.equal(deriveState({ lastRole: "user", secondsSinceLastMessage: 60 }), "working", "user spoke last → working");
assert.equal(deriveState({ lastRole: "assistant", secondsSinceLastMessage: IDLE_AFTER_SECONDS }), "idle", "stale → idle regardless of role");

// --- reconcile: first poll stamps firstSeen + stateSince to now ---
const T0 = "2026-06-09T10:06:00.000Z";
const snap0 = reconcile(null, [row({ id: "a", lastRole: "user" })], T0);
assert.equal(snap0.threads[0].state, "working");
assert.equal(snap0.threads[0].firstSeen, T0, "firstSeen = now on first sight");
assert.equal(snap0.threads[0].stateSince, T0, "stateSince = now on first sight");
assert.equal(snap0.threads[0].previousState, undefined);

// --- reconcile: unchanged state keeps stateSince; firstSeen persists ---
const T1 = "2026-06-09T10:07:00.000Z";
const snap1 = reconcile(snap0, [row({ id: "a", lastRole: "user" })], T1);
assert.equal(snap1.threads[0].stateSince, T0, "stateSince unchanged while state holds");
assert.equal(snap1.threads[0].firstSeen, T0, "firstSeen persists");

// --- reconcile: a real transition resets stateSince + records previousState ---
const T2 = "2026-06-09T10:08:00.000Z";
const snap2 = reconcile(snap1, [row({ id: "a", lastRole: "assistant" })], T2);
assert.equal(snap2.threads[0].state, "needs-you", "user→assistant flips working→needs-you");
assert.equal(snap2.threads[0].stateSince, T2, "stateSince resets on transition");
assert.equal(snap2.threads[0].previousState, "working", "previousState recorded");

// --- becameNeedsYou: the working→needs-you transition is the only refresh trigger ---
assert.deepEqual(becameNeedsYou(diffSnapshots(snap1, snap2)).map((t) => t.id), ["a"], "working→needs-you fires");
assert.deepEqual(becameNeedsYou(diffSnapshots(snap0, snap1)), [], "no transition into needs-you → no refresh");

// --- diff: appeared / transitioned / resolved ---
const withB: StatusSnapshot = reconcile(snap2, [row({ id: "a", lastRole: "assistant" }), row({ id: "b", lastRole: "user" })], "2026-06-09T10:09:00.000Z");
const d = diffSnapshots(snap2, withB);
assert.deepEqual(d.appeared.map((t) => t.id), ["b"], "b appeared");
assert.equal(d.transitioned.length, 0, "a held steady");
const gone = reconcile(withB, [row({ id: "b", lastRole: "user" })], "2026-06-09T10:10:00.000Z");
assert.deepEqual(diffSnapshots(withB, gone).resolved.map((t) => t.id), ["a"], "a resolved (dropped off the scan)");

// --- sortByAttention: needs-you before working before idle ---
const mixed = reconcile(null, [
  row({ id: "i", lastRole: "assistant", secondsSinceLastMessage: IDLE_AFTER_SECONDS }),
  row({ id: "w", lastRole: "user" }),
  row({ id: "n", lastRole: "assistant" }),
], "2026-06-09T10:11:00.000Z");
assert.deepEqual(sortByAttention(mixed.threads).map((t) => t.state), ["needs-you", "working", "idle"], "attention order");

// --- cleanTopic: strip command/caveat markup ---
assert.equal(cleanTopic("<command-name>/goal</command-name> ship it"), "/goal ship it", "tags stripped");
assert.equal(cleanTopic("  spaced   out  "), "spaced out", "whitespace collapsed");
assert.equal(cleanTopic("<x></x>"), "(untitled)", "empty after strip → placeholder");
// reconcile applies it
assert.equal(reconcile(null, [row({ id: "z", topic: "<command-message>review</command-message> the diff" })], "2026-06-09T10:00:00.000Z").threads[0].topic, "review the diff", "reconcile cleans topics");

// --- formatRelative ---
assert.equal(formatRelative(10), "just now");
assert.equal(formatRelative(60), "1 minute ago");
assert.equal(formatRelative(600), "10 minutes ago");
assert.equal(formatRelative(3600), "1 hour ago");
assert.equal(formatRelative(172800), "2 days ago");

process.stdout.write("ok — status state machine passed\n");
