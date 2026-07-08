// Deterministic test of the state machine — pure functions, no model, no I/O.
//   npm test   (from packages/core/)
// Covers state derivation, continuity (firstSeen), diff, and attention sort.
// (State history — stateSince/previousState — now lives in the db's thread_details
// ledger, not on the in-memory ThreadStatus; see src/gateway/threads-db.ts.)

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
  source: "claude", repo: "demo", app: "Claude CLI", topic: "t",
  lastRole: "assistant", createdAt: "2026-06-09T10:00:00.000Z",
  lastMessageAt: "2026-06-09T10:05:00.000Z", secondsSinceLastMessage: 60, secondsSinceActivity: 60, working: false, ...over,
});

// --- deriveState ---
assert.equal(deriveState({ lastRole: "assistant", secondsSinceLastMessage: 60, working: false }), "needs-you", "assistant yielded → needs-you");
assert.equal(deriveState({ lastRole: "user", secondsSinceLastMessage: 60, working: false }), "working", "user spoke last → working");
assert.equal(deriveState({ lastRole: "assistant", secondsSinceLastMessage: 60, working: true }), "working", "turn in progress → working even though the assistant spoke last (the bug fix)");
assert.equal(deriveState({ lastRole: "assistant", secondsSinceLastMessage: IDLE_AFTER_SECONDS, working: false }), "idle", "message-quiet → idle (file mtime noise must not keep threads alive)");
assert.equal(deriveState({ lastRole: "assistant", secondsSinceLastMessage: IDLE_AFTER_SECONDS, working: true }), "working", "a long-running turn outranks message-quiet idle");

// --- reconcile: first poll stamps firstSeen to now ---
const T0 = "2026-06-09T10:06:00.000Z";
const snap0 = reconcile(null, [row({ id: "a", lastRole: "user" })], T0);
assert.equal(snap0.threads[0].state, "working");
assert.equal(snap0.threads[0].firstSeen, T0, "firstSeen = now on first sight");

// --- reconcile: firstSeen persists across polls ---
const T1 = "2026-06-09T10:07:00.000Z";
const snap1 = reconcile(snap0, [row({ id: "a", lastRole: "user" })], T1);
assert.equal(snap1.threads[0].firstSeen, T0, "firstSeen persists");

// --- reconcile: a real transition flips state ---
const T2 = "2026-06-09T10:08:00.000Z";
const snap2 = reconcile(snap1, [row({ id: "a", lastRole: "assistant" })], T2);
assert.equal(snap2.threads[0].state, "needs-you", "user→assistant flips working→needs-you");

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

// --- manual done persists until a newer message arrives ---
const markedDone: StatusSnapshot = {
  polledAt: snap2.polledAt,
  threads: [{ ...snap2.threads[0], state: "done" }],
};
const stillDone = reconcile(markedDone, [row({ id: "a", lastRole: "assistant", lastMessageAt: snap2.threads[0].lastMessageAt })], "2026-06-09T10:10:00.000Z");
assert.equal(stillDone.threads[0].state, "done", "done survives polls with no newer message");
const reawakened = reconcile(stillDone, [row({ id: "a", lastRole: "assistant", lastMessageAt: "2026-06-09T10:11:00.000Z" })], "2026-06-09T10:12:00.000Z");
assert.equal(reawakened.threads[0].state, "needs-you", "newer message reactivates from done");

// --- workspace git delta rides through reconcile untouched ---
const withDiff = reconcile(null, [row({ id: "g", diffAdded: 12, diffDeleted: 4 })], T0);
assert.deepEqual([withDiff.threads[0].diffAdded, withDiff.threads[0].diffDeleted], [12, 4], "scan delta lands on ThreadStatus");

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
