// Deterministic test of the THREAD DB only (no model, no poller).
//   npm run test:db   (from harness/)
// Drives ThreadDb through the write APIs with an injected clock and asserts the
// invariants: upsert semantics, state-edge events, triage versioning, the sidebar
// projection + activeSince window, and durability across reopen.

import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ThreadDb, type ThreadDbEvent } from "./threads-db";

const dir = mkdtempSync(join(tmpdir(), "oo-threads-db-"));
const dbPath = join(dir, "threads.db");

// Injected clock: each write gets a distinct, ordered timestamp.
let tick = 0;
const now = () => new Date(Date.UTC(2026, 5, 9, 12, 0, tick++)).toISOString();

try {
  const db = new ThreadDb(dbPath, { now });
  const events: ThreadDbEvent[] = [];
  const unsubscribe = db.subscribe((e) => events.push(e));

  // --- first poll: new thread → thread_added ---
  const r1 = db.recordScan({
    id: "abc-123", repo: "amplify", app: "Claude Code", source: "claude",
    transcriptPath: "/tmp/abc.jsonl", createdAt: "2026-06-09T10:00:00Z",
    lastActiveAt: "2026-06-09T11:00:00Z", rawTopic: "fix 422s",
    state: "working",
  });
  assert.deepEqual(r1, { added: true, stateChanged: null });
  assert.deepEqual(events.at(-1), { type: "thread_added", threadId: "abc-123", state: "working" });

  // --- same state again: update, NO edge event ---
  const before = events.length;
  const r2 = db.recordScan({ id: "abc-123", state: "working", lastActiveAt: "2026-06-09T11:05:00Z" });
  assert.deepEqual(r2, { added: false, stateChanged: null });
  assert.equal(events.length, before, "steady state emits nothing");

  // --- omitted identity fields keep their stored value ---
  let row = db.listSidebar().find((r) => r.id === "abc-123")!;
  assert.equal(row.repo, "amplify", "repo survives a partial observation");
  assert.equal(row.topic, "fix 422s", "raw_topic shows until triage lands");

  // --- state flip: working → needs-you edge ---
  const r3 = db.recordScan({ id: "abc-123", state: "needs-you", stateReason: "agent asked a question" });
  assert.deepEqual(r3.stateChanged, { from: "working", to: "needs-you" });
  assert.deepEqual(events.at(-1), {
    type: "state_changed", threadId: "abc-123",
    from: "working", to: "needs-you", reason: "agent asked a question",
  });

  // --- state_reason rule: steady-state poll without a reason keeps the stored one ---
  db.recordScan({ id: "abc-123", state: "needs-you" });
  row = db.listSidebar().find((r) => r.id === "abc-123")!;
  assert.equal(row.stateReason, "agent asked a question", "steady state preserves the reason");
  // ...a state CHANGE without a reason clears it (stale reason on a new state is worse)
  db.recordScan({ id: "abc-123", state: "working" });
  row = db.listSidebar().find((r) => r.id === "abc-123")!;
  assert.equal(row.stateReason, null, "state change overwrites the reason");
  db.recordScan({ id: "abc-123", state: "needs-you", stateReason: "agent asked a question" });

  // --- triage: versions are per-thread, monotonic; latest wins in the projection ---
  const v1 = db.addTriage("abc-123", { priority: 3, topic: "Amplify 422 contract mismatch", nextSteps: "paste the drafted reply", source: "startup" });
  const v2 = db.addTriage("abc-123", { priority: 5, topic: "Amplify 422 contract mismatch", nextSteps: "review and push", source: "targeted_refresh" });
  assert.equal(v1, 1);
  assert.equal(v2, 2);
  assert.deepEqual(events.at(-1), { type: "triage_updated", threadId: "abc-123", version: 2 });
  assert.equal(db.getLatestTriage("abc-123")!.nextSteps, "review and push");

  // --- sidebar projection: triaged topic overrides raw, state + priority present ---
  row = db.listSidebar().find((r) => r.id === "abc-123")!;
  assert.equal(row.topic, "Amplify 422 contract mismatch");
  assert.equal(row.priority, 5);
  assert.equal(row.state, "needs-you");
  assert.equal(row.stateReason, "agent asked a question");

  // --- second thread orders by last_active_at DESC ---
  db.recordScan({ id: "def-456", repo: "owner-operator", state: "idle", lastActiveAt: "2026-06-09T11:30:00Z" });
  const ids = db.listSidebar().map((r) => r.id);
  assert.deepEqual(ids, ["def-456", "abc-123"], "most recently active first");

  // --- activeSince window: quiet threads age out, needs-you is exempt ---
  // def-456 (idle, 11:30) falls outside the window; abc-123 (needs-you, 11:05) is exempt.
  const windowed = db.listSidebar({ activeSince: "2026-06-09T12:00:00Z" });
  assert.deepEqual(windowed.map((r) => r.id), ["abc-123"], "idle ages out, needs-you stays");
  db.recordScan({ id: "def-456", state: "idle", lastActiveAt: "2026-06-09T12:30:00Z" });
  assert.equal(db.listSidebar({ activeSince: "2026-06-09T12:00:00Z" }).length, 2, "fresh activity re-enters the window");

  // --- guards ---
  assert.throws(() => db.recordScan({ id: "x", state: "banana" as never }), /invalid thread state/);
  assert.throws(() => db.addTriage("no-such-thread", { source: "manual" }), /FOREIGN KEY/i, "triage requires an existing thread");

  // --- unsubscribe stops delivery ---
  unsubscribe();
  const after = events.length;
  db.recordScan({ id: "abc-123", state: "done", stateReason: "marked done" });
  assert.equal(events.length, after, "unsubscribed listener hears nothing");

  db.close();

  // --- durability: reopen and the state is all still there ---
  const reopened = new ThreadDb(dbPath, { now });
  const persisted = reopened.listSidebar().find((r) => r.id === "abc-123")!;
  assert.equal(persisted.state, "done");
  assert.equal(persisted.priority, 5);
  assert.equal(reopened.getLatestTriage("abc-123")!.version, 2);
  reopened.close();

  process.stdout.write("ok — thread db passed\n");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
