// Integration: a delegated child whose run reached a terminal status is Done, so it leaves the
// active view instead of sitting under its parent forever (issue #226).
//
// The run ledger knows the child's work ended. The classifier that writes `thread_details` does
// not, and left five finished review children at `idle` under one parent. Done here is derived
// in the State projection and never written into the details ledger, and it is released the way
// an owner Done mark is, by a message newer than the mark.
//
// Each case below is written to fail if the mark changes meaning. Comparing the scan's clock or
// the query clock instead of the message time, or a run's start instead of the end of its work,
// has to break one of these.
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRunHarness, AgentRunStatus, type ScanRow } from "@owner-operator/core";
import { InMemoryEventBus } from "./event-bus";
import { State } from "./state";

const dir = mkdtempSync(join(tmpdir(), "oo-finished-child-"));
const previousOoHome = process.env.OO_HOME;
process.env.OO_HOME = dir;

const scanRow = (id: string, lastMessageAt = "2026-11-16T10:05:00.000Z"): ScanRow => ({
  id,
  source: "codex",
  repo: "stitcher",
  project: dir,
  app: "Codex App",
  topic: "PR #84 Fly configuration review",
  lastRole: "assistant",
  createdAt: "2026-11-16T10:00:00.000Z",
  lastMessageAt,
  secondsSinceLastMessage: 120,
  secondsSinceActivity: 120,
  working: false,
});

const visible = (state: State, id: string) =>
  state.listCurrentSessionState().find((row) => row.id === id);

// Done is released by a message newer than the end of the child's work, so the clock has to move
// for the release rule to mean anything.
let now = "2026-11-16T10:06:00.000Z";

let closeState: (() => void) | undefined;
try {
  const state = new State(join(dir, "state.db"), {
    bus: new InMemoryEventBus(),
    now: () => now,
    activeWindow: "1d",
  });
  closeState = () => state.close();
  const delegate = (parentThreadId: string, task: string, depth: number, childSessionId?: string) =>
    state.createAgentRun({
      harness: AgentRunHarness.Codex,
      task,
      cwd: dir,
      parentThreadId,
      depth,
      timeoutSeconds: 3_600,
      ...(childSessionId ? { childSessionId } : {}),
    });
  const complete = (id: string) =>
    state.finishAgentRun(id, { status: AgentRunStatus.Completed, resultTail: "done", error: null });

  state.recordObservation({ ...scanRow("operator-thread"), source: "pi", app: "Owner Operator", topic: "Harness answers backfill" });
  delegate("operator-thread", "review PR #84", 1);
  const running = state.claimNextPendingAgentRun(3)!;
  state.recordAgentRunActivity(running.id, { childSessionId: "codex-child" });
  state.recordObservation(scanRow("codex-child"));
  assert.equal(visible(state, "codex-child")?.state, "idle", "a child with a live run shows its transcript-derived state");

  complete(running.id);
  assert.equal(visible(state, "codex-child"), undefined, "a completed run's child is Done and leaves the active view");
  assert.equal(visible(state, "operator-thread")?.state, "idle", "the parent keeps its own transcript-derived state");

  // A later poll re-reads the same transcript. Nothing about the session changed, so the row
  // stays Done. A mark read from the scan's clock or the query's clock would revive it here.
  now = "2026-11-16T10:08:00.000Z";
  state.recordObservation(scanRow("codex-child"));
  assert.equal(visible(state, "codex-child"), undefined, "an unchanged later poll leaves the finished child Done");

  // The model's own assessment of a finished child cannot pull it back. The run ledger decides.
  state.appendEnrichment("codex-child", { topic: "PR #84 Fly configuration review", statusSummary: "Review posted", attention: "needs-you" }, "2026-11-16T10:05:00.000Z");
  assert.equal(visible(state, "codex-child"), undefined, "a model needs-you verdict does not revive a finished child");
  assert.ok(
    !state.listNeedsYouMessageVersions().some(({ threadId }) => threadId === "codex-child"),
    "a finished child is not a needs-you schedule input",
  );

  // A child that delegated work of its own is working until that subtree settles, the same rule
  // the parent gets, so Done never hides a live grandchild.
  const secrets = delegate("codex-child", "check the Fly secrets", 2);
  assert.equal(visible(state, "codex-child")?.state, "working", "an active grandchild keeps the finished child visible");
  const runningSecrets = state.claimNextPendingAgentRun(3)!;
  assert.equal(runningSecrets.id, secrets.id);
  complete(runningSecrets.id);
  assert.equal(visible(state, "codex-child"), undefined, "the child is Done again once its own subtree settles");

  // A fresh round against the same child session is a new run, and its own liveness holds the
  // row open. No newer message exists yet, so only the live run can explain the row.
  now = "2026-11-16T10:10:00.000Z";
  const followUp = delegate("operator-thread", "answer the review follow-up", 1, "codex-child");
  assert.ok(visible(state, "codex-child"), "a live round holds the finished child's row open");
  const runningFollowUp = state.claimNextPendingAgentRun(3)!;
  assert.equal(runningFollowUp.id, followUp.id);

  // The owner steers that round while it works. The message belongs to the round, so the round's
  // end settles the row. A mark read from the run's start would leave this row visible.
  state.recordObservation({ ...scanRow("codex-child", "2026-11-16T10:12:00.000Z"), lastRole: "user" });
  now = "2026-11-16T10:14:00.000Z";
  complete(runningFollowUp.id);
  assert.equal(visible(state, "codex-child"), undefined, "a round that ends after the owner's steer settles the row");

  // The owner picks the finished child up by hand in its own harness. That message is newer than
  // the end of its work, which releases Done the same way it releases an owner Done mark.
  now = "2026-11-16T10:21:00.000Z";
  state.recordObservation({ ...scanRow("codex-child", "2026-11-16T10:20:00.000Z"), lastRole: "user" });
  assert.equal(visible(state, "codex-child")?.state, "working", "a message newer than the finished run wakes the child again");

  // A run abandoned by a daemon restart is marked interrupted whenever the next daemon starts,
  // which can be long after the child stopped and after the owner continued the session. The
  // sweep's clock is not evidence about the child, so the run's own last activity is the mark.
  const abandoned = delegate("operator-thread", "re-check the Fly release", 1, "codex-child");
  const runningAbandoned = state.claimNextPendingAgentRun(3)!;
  assert.equal(runningAbandoned.id, abandoned.id);
  now = "2026-11-16T10:22:00.000Z";
  state.recordAgentRunActivity(runningAbandoned.id, { activity: "reading fly.toml" });
  now = "2026-11-16T10:31:00.000Z";
  state.recordObservation({ ...scanRow("codex-child", "2026-11-16T10:30:00.000Z"), lastRole: "user" });
  now = "2026-11-16T10:40:00.000Z";
  assert.deepEqual(state.markRunningAgentRunsInterrupted("daemon restarted during execution"), [abandoned.id]);
  assert.equal(
    visible(state, "codex-child")?.state,
    "working",
    "a late interruption sweep does not bury a session the owner continued before it ran",
  );

  // Delegation nests to depth 5, and only the deepest run is live here. A thread with live work
  // anywhere below it keeps its row, so the live branch never loses its visible ancestors.
  const lineage = ["codex-child", "depth-two", "depth-three", "depth-four"];
  lineage.slice(1).forEach((id, index) => {
    const parent = lineage[index];
    const hop = delegate(parent, `trace the deployment from ${parent}`, index + 2);
    const runningHop = state.claimNextPendingAgentRun(3)!;
    assert.equal(runningHop.id, hop.id);
    state.recordAgentRunActivity(runningHop.id, { childSessionId: id });
    // The middle thread's transcript is never observed, so ancestry has to come from the ledger.
    if (id !== "depth-three") state.recordObservation(scanRow(id, "2026-11-16T10:35:00.000Z"));
    complete(runningHop.id);
  });
  const deepest = delegate("depth-four", "read the Fly logs", 5);
  assert.equal(deepest.depth, 5);
  assert.equal(visible(state, "depth-four")?.state, "working", "the thread with the live run directly below it is working");
  assert.ok(visible(state, "depth-two"), "an ancestor three levels above the live run keeps its row");
  assert.equal(visible(state, "depth-three"), undefined, "an unobserved thread has no row to keep");

  process.stdout.write("ok — a finished delegated child is Done, and a newer message, a new round, or live work below it wakes the row\n");
} finally {
  closeState?.();
  if (previousOoHome === undefined) delete process.env.OO_HOME;
  else process.env.OO_HOME = previousOoHome;
  rmSync(dir, { recursive: true, force: true });
}
