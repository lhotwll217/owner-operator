// Integration: a delegated child whose run reached a terminal status is Done, so it leaves the
// active view instead of sitting under its parent forever (issue #225).
//
// The run ledger knows the child's work ended; the model classifier that writes `thread_details`
// does not, and left six finished review children at `idle`. Done here is derived in the State
// projection from `agent_runs.status`, never written into the details ledger, so a new round for
// the same child session (retry or resume creates a new run) brings its row straight back.
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

const scanRow = (id: string): ScanRow => ({
  id,
  source: "codex",
  repo: "stitcher",
  project: dir,
  app: "Codex App",
  topic: "PR #84 Fly configuration review",
  lastRole: "assistant",
  createdAt: "2026-11-16T10:00:00.000Z",
  lastMessageAt: "2026-11-16T10:05:00.000Z",
  secondsSinceLastMessage: 120,
  secondsSinceActivity: 120,
  working: false,
});

const visible = (state: State, id: string) =>
  state.listCurrentSessionState().find((row) => row.id === id);

let closeState: (() => void) | undefined;
try {
  const state = new State(join(dir, "state.db"), {
    bus: new InMemoryEventBus(),
    now: () => "2026-11-16T10:06:00.000Z",
    activeWindow: "1d",
  });
  closeState = () => state.close();

  state.recordObservation({ ...scanRow("operator-thread"), source: "pi", app: "Owner Operator", topic: "Harness answers backfill" });
  const run = state.createAgentRun({
    harness: AgentRunHarness.Codex,
    task: "review PR #84",
    cwd: dir,
    parentThreadId: "operator-thread",
    depth: 1,
    timeoutSeconds: 3_600,
  });
  const running = state.claimNextPendingAgentRun(3)!;
  state.recordAgentRunActivity(running.id, { childSessionId: "codex-child" });
  state.recordObservation(scanRow("codex-child"));
  assert.equal(visible(state, "codex-child")?.state, "idle", "a child with a live run shows its transcript-derived state");

  state.finishAgentRun(running.id, { status: AgentRunStatus.Completed, resultTail: "reviewed", error: null });
  state.recordObservation(scanRow("codex-child"));
  assert.equal(visible(state, "codex-child"), undefined, "a completed run's child is Done and leaves the active view");
  assert.equal(visible(state, "operator-thread")?.state, "idle", "the parent keeps its own transcript-derived state");

  // The model's own assessment of a finished child cannot pull it back: the run ledger decides.
  state.appendEnrichment("codex-child", { topic: "PR #84 Fly configuration review", statusSummary: "Review posted", attention: "needs-you" }, "2026-11-16T10:05:00.000Z");
  assert.equal(visible(state, "codex-child"), undefined, "a model needs-you verdict does not revive a finished child");
  assert.ok(
    !state.listNeedsYouMessageVersions().some(({ threadId }) => threadId === "codex-child"),
    "a finished child is not a needs-you schedule input",
  );

  // A child that delegated work of its own is still working until that subtree settles, the same
  // rule the parent gets, so Done never hides a live grandchild.
  const grandchild = state.createAgentRun({
    harness: AgentRunHarness.Codex,
    task: "check the Fly secrets",
    cwd: dir,
    parentThreadId: "codex-child",
    depth: 2,
    timeoutSeconds: 3_600,
  });
  assert.equal(visible(state, "codex-child")?.state, "working", "an active grandchild keeps the finished child visible");
  const runningGrandchild = state.claimNextPendingAgentRun(3)!;
  assert.equal(runningGrandchild.id, grandchild.id);
  state.finishAgentRun(runningGrandchild.id, { status: AgentRunStatus.Completed, resultTail: "checked", error: null });
  assert.equal(visible(state, "codex-child"), undefined, "the child is Done again once its own subtree settles");

  // Retry and resume create a new run against the same child session; that run reopens the row.
  state.createAgentRun({
    harness: AgentRunHarness.Codex,
    task: "answer the review follow-up",
    cwd: dir,
    parentThreadId: "operator-thread",
    depth: 1,
    timeoutSeconds: 3_600,
    childSessionId: "codex-child",
    resumeOfRunId: run.id,
  });
  assert.equal(visible(state, "codex-child")?.state, "idle", "a fresh round for the same child session brings its row back");

  process.stdout.write("ok — a finished delegated child is Done and a new round wakes it\n");
} finally {
  closeState?.();
  if (previousOoHome === undefined) delete process.env.OO_HOME;
  else process.env.OO_HOME = previousOoHome;
  rmSync(dir, { recursive: true, force: true });
}
