// Unit: the agent_runs ledger seam on ThreadDb — lifecycle guards, monotonic terminal
// states, claim-under-cap, restart interruption, lost reconciliation, resume lineage,
// and the parent/child join into the session-state projection.
import assert from "node:assert";
import { AgentRunHarness, AgentRunStatus } from "@owner-operator/core";
import { ThreadDb } from "./database";

let nowIso = "2026-07-17T10:00:00.000Z";
const db = new ThreadDb(":memory:", { now: () => nowIso });

const input = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  harness: AgentRunHarness.ClaudeCode,
  task: "summarize the repo",
  cwd: "/tmp/repo",
  parentThreadId: "parent-thread",
  depth: 1,
  timeoutSeconds: 3_600,
  ...overrides,
});

// --- create → pending, fields persisted -------------------------------------------------
const created = db.createAgentRun(input("run-1"));
assert.equal(created.status, AgentRunStatus.Pending, "new runs are pending");
assert.equal(created.harness, AgentRunHarness.ClaudeCode);
assert.equal(created.parentThreadId, "parent-thread");
assert.equal(created.depth, 1);
assert.equal(created.startedAt, null, "pending runs have not started");
assert.equal(created.resumeOfRunId, null);

// --- claim-under-cap: oldest pending starts; cap counts running rows ---------------------
db.createAgentRun(input("run-2"));
const claimed1 = db.claimNextPendingAgentRun(1);
assert.equal(claimed1?.id, "run-1", "oldest pending run is claimed first");
assert.equal(claimed1?.status, AgentRunStatus.Running);
assert.ok(claimed1?.startedAt, "claiming stamps started_at");
assert.equal(db.claimNextPendingAgentRun(1), null, "cap 1 with one running claims nothing");
const claimed2 = db.claimNextPendingAgentRun(2);
assert.equal(claimed2?.id, "run-2", "raising the cap releases the queue");

// --- explicit activity + child identity, only while running ------------------------------
const active = db.recordAgentRunActivity("run-1", {
  activity: "reading src/state",
  childSessionId: "child-session-1",
  acpxRecordId: "acpx-rec-1",
});
assert.equal(active?.activity, "reading src/state");
assert.equal(active?.childSessionId, "child-session-1");
assert.equal(active?.acpxRecordId, "acpx-rec-1");
assert.equal(active?.lastActivityAt, nowIso, "activity stamps last_activity_at");

// --- protocol result finalizes; terminal states are monotonic ----------------------------
const finished = db.finishAgentRun("run-1", {
  status: AgentRunStatus.Completed,
  resultTail: "the report",
  error: null,
});
assert.equal(finished?.status, AgentRunStatus.Completed);
assert.equal(finished?.resultTail, "the report");
assert.ok(finished?.finishedAt, "finishing stamps finished_at");
assert.equal(
  db.finishAgentRun("run-1", { status: AgentRunStatus.Failed, resultTail: null, error: "late" }),
  null,
  "a terminal row never changes status again",
);
assert.equal(
  db.recordAgentRunActivity("run-1", { activity: "zombie" }),
  null,
  "activity on a terminal row is rejected",
);
assert.equal(db.agentRunById("run-1")?.status, AgentRunStatus.Completed, "monotonic survives late writes");

// --- cancel before start: pending → cancelled is legal -----------------------------------
db.createAgentRun(input("run-3"));
const cancelled = db.finishAgentRun("run-3", {
  status: AgentRunStatus.Cancelled,
  resultTail: null,
  error: "cancelled before start",
});
assert.equal(cancelled?.status, AgentRunStatus.Cancelled);

// --- restart: running rows become interrupted (resumable), pending stay pending ----------
db.createAgentRun(input("run-4"));
assert.equal(db.markRunningAgentRunsInterrupted("daemon restarted").length, 1, "run-2 was running");
assert.equal(db.agentRunById("run-2")?.status, AgentRunStatus.Interrupted);
assert.equal(db.agentRunById("run-2")?.error, "daemon restarted");
assert.equal(db.agentRunById("run-4")?.status, AgentRunStatus.Pending, "pending rows survive restart");

// --- lost: running row with no live turn past the grace cutoff, never a live one ---------
const running4 = db.claimNextPendingAgentRun(3);
assert.equal(running4?.id, "run-4");
db.createAgentRun(input("run-5"));
const running5 = db.claimNextPendingAgentRun(3);
assert.equal(running5?.id, "run-5");
nowIso = "2026-07-17T10:10:00.000Z";
const lostIds = db.markAgentRunsLost(["run-5"], "2026-07-17T10:05:00.000Z");
assert.deepEqual(lostIds, ["run-4"], "stale non-live running row goes lost");
assert.equal(db.agentRunById("run-4")?.status, AgentRunStatus.Lost);
assert.equal(db.agentRunById("run-5")?.status, AgentRunStatus.Running, "live turns are never reclaimed");
db.recordAgentRunActivity("run-5", { activity: "still going" });
assert.deepEqual(
  db.markAgentRunsLost([], "2026-07-17T10:09:00.000Z"),
  [],
  "recent activity keeps a row out of lost even without a live turn",
);

// --- resume: same child identity, new run row with lineage -------------------------------
const interrupted = db.agentRunById("run-2")!;
const resumed = db.createAgentRun(input("run-6", {
  resumeOfRunId: interrupted.id,
  childSessionId: "child-session-2",
  acpxRecordId: "acpx-rec-2",
}));
assert.equal(resumed.resumeOfRunId, "run-2", "resume records lineage to the interrupted run");
assert.equal(resumed.childSessionId, "child-session-2", "resume carries the child identity");
assert.equal(resumed.status, AgentRunStatus.Pending, "a resume is a new run, not a status downgrade");

// --- listing: newest first, parent filter ------------------------------------------------
const all = db.listAgentRuns();
assert.equal(all.length, 6);
assert.equal(all[0].id, "run-6", "newest first");
assert.equal(db.listAgentRuns({ parentThreadId: "parent-thread" }).length, 6);
assert.equal(db.listAgentRuns({ parentThreadId: "other" }).length, 0);

// --- child-session lookup underpins the depth guard and monitor join ---------------------
assert.equal(db.agentRunByChildSession("child-session-1")?.id, "run-1", "a child session resolves to its run");
assert.equal(db.agentRunByChildSession("no-such-child"), undefined, "an unknown child session resolves to nothing");

// --- model is persisted and returned -----------------------------------------------------
const withModel = db.createAgentRun(input("run-7", { model: "claude-opus-4-8" }));
assert.equal(withModel.model, "claude-opus-4-8", "a pinned model round-trips");
assert.equal(db.createAgentRun(input("run-8")).model, null, "an unpinned model is null");

// --- projection join: a scanned child thread carries its parent --------------------------
db.recordScan({
  id: "child-session-1",
  repo: "owner-operator",
  source: "claude",
  app: "Claude Code",
  rawTopic: "delegated research",
  state: "working",
  lastMessageAt: nowIso,
});
db.recordScan({
  id: "unrelated-thread",
  repo: "owner-operator",
  source: "codex",
  app: "Codex",
  rawTopic: "normal session",
  state: "working",
  lastMessageAt: nowIso,
});
const rows = db.listSessionState();
const child = rows.find((row) => row.id === "child-session-1");
const unrelated = rows.find((row) => row.id === "unrelated-thread");
assert.equal(child?.parentThreadId, "parent-thread", "child session joins to its delegating thread");
assert.equal(unrelated?.parentThreadId, null, "ordinary threads have no parent");

db.close();
process.stdout.write("ok — agent_runs ledger lifecycle, reconciliation, lineage\n");
