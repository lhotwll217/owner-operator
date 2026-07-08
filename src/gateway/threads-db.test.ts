// Deterministic test of the THREAD DB only (no model, no poller).
//   npm run test:unit
// Drives ThreadDb through the write APIs with an injected clock and asserts the
// invariants: upsert semantics, state-edge events, the dense append-only details
// ledger, the session-state projection, durability across reopen, and the one-time
// legacy migration.

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
    id: "abc-123", repo: "billing", app: "Claude CLI", source: "claude",
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
  let row = db.listSessionState().find((r) => r.id === "abc-123")!;
  assert.equal(row.repo, "billing", "repo survives a partial observation");
  assert.equal(row.topic, "fix 422s", "raw_topic shows until model details land");

  // --- state flip: working → needs-you edge ---
  const r3 = db.recordScan({ id: "abc-123", state: "needs-you", stateReason: "agent asked a question" });
  assert.deepEqual(r3.stateChanged, { from: "working", to: "needs-you" });
  assert.deepEqual(events.at(-1), {
    type: "state_changed", threadId: "abc-123",
    from: "working", to: "needs-you", reason: "agent asked a question",
  });

  // --- state_reason rule: steady-state poll without a reason keeps the stored one ---
  db.recordScan({ id: "abc-123", state: "needs-you" });
  row = db.listSessionState().find((r) => r.id === "abc-123")!;
  assert.equal(row.stateReason, "agent asked a question", "steady state preserves the reason");
  // ...a state CHANGE without a reason clears it (stale reason on a new state is worse)
  db.recordScan({ id: "abc-123", state: "working" });
  row = db.listSessionState().find((r) => r.id === "abc-123")!;
  assert.equal(row.stateReason, null, "state change overwrites the reason");
  db.recordScan({ id: "abc-123", state: "needs-you", stateReason: "agent asked a question" });

  // --- model enrichment: appends ledger versions; latest wins in the projection ---
  // State edges already wrote versions (working→needs-you→working→needs-you = v1..v4),
  // so the model's appends continue the same per-thread ledger.
  const v5 = db.appendModelDetails("abc-123", { priority: 3, topic: "Billing 422 contract mismatch", nextSteps: "paste the drafted reply" });
  const v6 = db.appendModelDetails("abc-123", { priority: 5, topic: "Billing 422 contract mismatch", nextSteps: "review and push" });
  assert.equal(v5, 5);
  assert.equal(v6, 6);
  assert.deepEqual(events.at(-1), { type: "details_updated", threadId: "abc-123", version: 6 });
  assert.equal(db.latestDetails("abc-123")!.nextSteps, "review and push");
  assert.equal(db.latestDetails("abc-123")!.writtenBy, "model");
  // Dense carry-forward: the model didn't claim state — it rides along from v4.
  assert.equal(db.latestDetails("abc-123")!.state, "needs-you", "state carries forward through a model append");
  assert.equal(db.latestDetails("abc-123")!.stateReason, "agent asked a question", "reason carries too");
  // Identical claim → no version churn.
  assert.equal(db.appendModelDetails("abc-123", { priority: 5, topic: "Billing 422 contract mismatch", nextSteps: "review and push" }), null, "unchanged enrichment appends nothing");

  // --- session-state projection: generated topic overrides raw, state + priority present ---
  row = db.listSessionState().find((r) => r.id === "abc-123")!;
  assert.equal(row.topic, "Billing 422 contract mismatch");
  assert.equal(row.priority, 5);
  assert.equal(row.state, "needs-you");
  assert.equal(row.stateReason, "agent asked a question");

  // --- second thread orders by last_active_at DESC ---
  db.recordScan({ id: "def-456", repo: "owner-operator", state: "idle", lastActiveAt: "2026-06-09T11:30:00Z" });
  const ids = db.listSessionState().map((r) => r.id);
  assert.deepEqual(ids, ["abc-123", "def-456"], "attention order first");

  // --- current session state: current-window rows only, needs-you is exempt ---
  // def-456 (idle, 11:30) falls outside the window; abc-123 (needs-you, 11:05) is exempt.
  const windowed = db.listSessionState({ activeSince: "2026-06-09T12:00:00Z" });
  assert.deepEqual(windowed.map((r) => r.id), ["abc-123"], "idle ages out, needs-you stays");
  db.recordScan({ id: "def-456", state: "idle", lastActiveAt: "2026-06-09T12:30:00Z" });
  assert.equal(db.listSessionState({ activeSince: "2026-06-09T12:00:00Z" }).length, 2, "fresh activity re-enters the window");

  // --- guards ---
  assert.throws(() => db.recordScan({ id: "x", state: "banana" as never }), /invalid thread state/);
  // Enrichment for a thread the poll hasn't seen: stub row so the FK holds, state defaults idle.
  assert.equal(db.appendModelDetails("pre-poll", { topic: "early bird" }), 1, "pre-poll enrichment lands as v1 on a stub");
  assert.equal(db.latestDetails("pre-poll")!.state, "idle");

  // --- unsubscribe stops delivery ---
  unsubscribe();
  const after = events.length;
  db.recordScan({ id: "abc-123", state: "done", stateReason: "marked done" });
  assert.equal(events.length, after, "unsubscribed listener hears nothing");

  db.close();

  // --- durability: reopen and the ledger is all still there ---
  const reopened = new ThreadDb(dbPath, { now });
  assert.equal(reopened.listSessionState().some((r) => r.id === "abc-123"), false, "done rows leave current session state");
  const final = reopened.latestDetails("abc-123")!;
  assert.equal(final.version, 7, "full ledger survives reopen (4 state edges + 2 model + done)");
  assert.equal(final.state, "done");
  assert.equal(final.topic, "Billing 422 contract mismatch", "enrichment carried through the done edge");
  reopened.close();

  // --- privacy purge: path tree (lower-level repos too), repo name, slug, CASCADE ---
  const pdb = new ThreadDb(join(dir, "purge.db"), { now });
  const status = (id: string, repo: string, project?: string) => ({
    id, source: "claude", repo, ...(project ? { project } : {}), app: "Claude CLI",
    topic: "t", state: "idle" as const, lastActive: "just now",
    createdAt: "2026-06-09T10:00:00Z", lastMessageAt: "2026-06-09T11:00:00Z",
    firstSeen: "2026-06-09T10:00:00Z",
  });
  pdb.saveSnapshot({
    polledAt: "2026-06-09T13:00:00Z",
    threads: [
      status("keep-1", "billing", "/u/dev/billing"),
      status("keep-2", "PersonalSite", "/u/Documents/PersonalSite"), // sibling prefix must NOT bleed
      status("priv-root", "Personal", "/u/Documents/Personal"),
      status("priv-deep", "acme", "/u/Documents/Personal/Career/Jobs/acme"), // lower-level repo
      status("priv-wt", "personal", "/u/.superset/worktrees/x/branch"),      // worktree → repo name
    ],
  });
  pdb.appendModelDetails("priv-deep", { topic: "private" });
  // A historical row with NO project value — only its transcript path identifies it.
  pdb.recordScan({ id: "priv-legacy", state: "idle", transcriptPath: "/u/.claude/projects/-u-Documents-Personal-Career/x.jsonl" });

  const bl = { paths: ["/u/Documents/Personal"], repos: ["Personal"] };
  assert.equal(pdb.purgeBlacklisted(bl), 4, "root + lower-level + worktree-by-name + legacy-by-slug purged");
  assert.deepEqual(pdb.loadSnapshot()!.threads.map((t) => t.id).sort(), ["keep-1", "keep-2"], "survivors intact");
  assert.equal(pdb.latestDetails("priv-deep"), undefined, "purged thread's ledger cascaded");
  assert.equal(pdb.purgeBlacklisted({ paths: [], repos: [] }), 0, "empty blacklist deletes nothing");
  pdb.close();

  // --- loadSnapshot: a needs-you thread is NEVER dropped, even when it ages out of the window ---
  // The live view renders loadSnapshot(). saveSnapshot only marks the current
  // scan window in_snapshot=1, so a thread blocked on the owner must be exempt there too — else it
  // silently vanishes once its activity falls outside the window. (Mirrors the listSessionState exemption.)
  const sdb = new ThreadDb(join(dir, "snapshot.db"), { now });
  const mk = (id: string, state: "needs-you" | "idle" | "working") => ({
    id, source: "claude", repo: "billing", app: "Claude CLI", topic: id, state, lastActive: "1 hour ago",
    createdAt: "2026-06-09T10:00:00Z", lastMessageAt: "2026-06-09T11:00:00Z",
    firstSeen: "2026-06-09T10:00:00Z",
  });
  sdb.saveSnapshot({ polledAt: "2026-06-09T12:00:00Z", threads: [mk("waiting", "needs-you"), mk("quiet", "idle")] });
  assert.deepEqual(sdb.loadSnapshot()!.threads.map((t) => t.id).sort(), ["quiet", "waiting"], "both present in the window");
  // Next poll: neither is in the scan window any more (a different thread is active now).
  sdb.saveSnapshot({ polledAt: "2026-06-09T13:00:00Z", threads: [mk("other", "working")] });
  const survived = sdb.loadSnapshot()!.threads.map((t) => t.id).sort();
  assert.deepEqual(survived, ["other", "waiting"], "needs-you survives aging out; the idle thread drops");
  sdb.close();

  // --- owner rename: preferred at display; model details keep versioning underneath (audit trail) ---
  const rdb = new ThreadDb(join(dir, "rename.db"), { now });
  rdb.recordScan({ id: "r-1", repo: "billing", app: "Claude CLI", rawTopic: "raw scan topic", state: "working" });
  rdb.appendModelDetails("r-1", { topic: "Model title", nextSteps: "n1", priority: 3 });
  assert.equal(rdb.setOwnerTitle("nope", "x"), false, "unknown thread → false");
  assert.equal(rdb.setOwnerTitle("r-1", "  My rename  "), true);
  assert.equal(rdb.listSessionState()[0].topic, "My rename", "owner title wins the projection (trimmed)");
  rdb.appendModelDetails("r-1", { topic: "Model retitle", nextSteps: "n2", priority: 4 });
  assert.equal(rdb.latestDetails("r-1")!.topic, "Model retitle", "model enrichment still records its topic (audit trail)");
  assert.equal(rdb.listSessionState()[0].topic, "My rename", "…but the owner title still shows");
  // The snapshot carries the rename, and a poll snapshot (which never has one) can't clear it.
  rdb.saveSnapshot({ polledAt: "2026-06-09T14:00:00Z", threads: [status("r-1", "billing")] });
  assert.equal(rdb.loadSnapshot()!.threads[0].ownerTitle, "My rename", "snapshot serves the rename; a plain poll can't clear it");
  assert.equal(rdb.setOwnerTitle("r-1", "   "), true, "whitespace clears the pin");
  assert.equal(rdb.loadSnapshot()!.threads[0].ownerTitle, undefined, "cleared pin leaves the snapshot");
  assert.equal(rdb.listSessionState()[0].topic, "Model retitle", "cleared → the latest generated title shows again");
  rdb.close();

  // --- legacy migration: pre-ledger db (mutable state on threads + thread_triage) ---
  // Seeds each thread's details v1 from current truth, rebuilds threads without the
  // moved/dead columns, and leaves thread_triage in place read-only.
  const legacyPath = join(dir, "legacy.db");
  {
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(legacyPath);
    raw.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY, repo TEXT, project TEXT, app TEXT, source TEXT,
        transcript_path TEXT, created_at TEXT, last_active_at TEXT,
        first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, raw_topic TEXT,
        owner_title TEXT,
        state TEXT NOT NULL DEFAULT 'idle', state_reason TEXT,
        last_assistant_at TEXT, last_user_at TEXT, last_checked_at TEXT,
        last_message_at TEXT, last_active_rel TEXT, state_since TEXT,
        previous_state TEXT, in_snapshot INTEGER NOT NULL DEFAULT 0,
        diff_added INTEGER, diff_deleted INTEGER
      );
      CREATE TABLE thread_triage (
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        version INTEGER NOT NULL, priority INTEGER, topic TEXT, summary TEXT,
        next_steps TEXT, source TEXT NOT NULL, model TEXT, prompt_version TEXT,
        input_hash TEXT, created_at TEXT NOT NULL, PRIMARY KEY (thread_id, version)
      );
      INSERT INTO threads (id, repo, state, state_reason, first_seen_at, last_seen_at, last_message_at, in_snapshot, owner_title)
        VALUES ('old-1', 'billing', 'needs-you', 'question pending', '2026-06-01T00:00:00Z', '2026-06-02T00:00:00Z', '2026-06-02T00:00:00Z', 1, 'Pinned name');
      INSERT INTO threads (id, repo, state, first_seen_at, last_seen_at)
        VALUES ('old-2', 'demo', 'idle', '2026-06-01T00:00:00Z', '2026-06-02T00:00:00Z');
      INSERT INTO thread_triage (thread_id, version, priority, topic, summary, next_steps, source, created_at)
        VALUES ('old-1', 1, 2, 'Old title', 's1', 'n1', 'model', '2026-06-01T01:00:00Z'),
               ('old-1', 2, 4, 'New title', 's2', 'n2', 'model', '2026-06-01T02:00:00Z');
    `);
    raw.close();
  }
  const migrated = new ThreadDb(legacyPath, { now });
  const m1 = migrated.latestDetails("old-1")!;
  assert.deepEqual(
    [m1.version, m1.writtenBy, m1.state, m1.stateReason, m1.priority, m1.topic, m1.summary, m1.nextSteps],
    [1, "migration", "needs-you", "question pending", 4, "New title", "s2", "n2"],
    "v1 = current truth: threads state + LATEST triage",
  );
  assert.deepEqual(
    [migrated.latestDetails("old-2")!.state, migrated.latestDetails("old-2")!.topic],
    ["idle", null],
    "thread without triage seeds from state alone",
  );
  const row1 = migrated.listSessionState().find((r) => r.id === "old-1")!;
  assert.equal(row1.topic, "Pinned name", "owner title survives the rebuild");
  // A steady-state write after migration dedups against the seeded v1.
  migrated.recordScan({ id: "old-2", state: "idle" });
  assert.equal(migrated.latestDetails("old-2")!.version, 1, "steady state after migration appends nothing");
  migrated.close();
  {
    const { DatabaseSync } = await import("node:sqlite");
    const check = new DatabaseSync(legacyPath, { readOnly: true });
    const cols = (check.prepare("PRAGMA table_info(threads)").all() as Array<{ name: string }>).map((c) => c.name);
    assert.ok(!cols.includes("state") && !cols.includes("state_since") && !cols.includes("last_active_rel"), "moved/dead columns dropped from threads");
    const { n } = check.prepare("SELECT COUNT(*) AS n FROM thread_triage").get() as { n: number };
    assert.equal(n, 2, "legacy triage history kept read-only");
    check.close();
  }
  // Idempotent: reopening the migrated db must not re-seed or throw.
  const again = new ThreadDb(legacyPath, { now });
  assert.equal(again.latestDetails("old-1")!.version, 1, "second open is a no-op");
  again.close();

  process.stdout.write("ok — thread db passed\n");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
