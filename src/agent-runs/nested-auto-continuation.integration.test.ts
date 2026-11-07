import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRunHarness, AgentRunStatus, type AgentRunLaunchRequest, type AgentRunLaunchResult } from "@owner-operator/core";
import { State } from "../state/state";
import { AgentRunExecutor } from "./executor";

const root = mkdtempSync(join(tmpdir(), "oo-nested-auto-"));
const priorHome = process.env.OO_HOME;
process.env.OO_HOME = root;
const waitFor = async (condition: () => boolean): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, "automatic nested continuation reached expected state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
const completed = (text: string): AgentRunLaunchResult =>
  ({ status: AgentRunStatus.Completed, resultText: text, error: null });
// One timestamp for every row, so newest-first order rests on insertion order alone.
const openState = (name: string): State => new State(join(root, name, "state.db"), { now: () => "2026-10-16T00:00:00.000Z" });

const heldUntilStop = (request: AgentRunLaunchRequest): Promise<AgentRunLaunchResult> => new Promise((resolve) => {
  request.signal.addEventListener("abort", () => resolve({
    status: AgentRunStatus.Cancelled, resultText: "", error: "aborted",
  }), { once: true });
});

/** Starts a parent that delegates one child; `onFollowUp` answers the daemon's automatic follow-up. */
function parentWithChild(name: string, onFollowUp: (request: AgentRunLaunchRequest) => Promise<AgentRunLaunchResult>,
  onChild = async (_request: AgentRunLaunchRequest) => completed("CHILD_TOKEN_189")) {
  const state = openState(name);
  const followUps: AgentRunLaunchRequest[] = [];
  let executor!: AgentRunExecutor;
  executor = new AgentRunExecutor(state, { tickMs: 10, logger: () => undefined,
    launcher: async (request) => {
      request.onActivity({ childSessionId: request.run.childSessionId ?? `session-${request.run.id}`,
        acpxRecordId: request.run.acpxRecordId ?? request.run.id });
      if (request.run.resumeOfRunId) {
        followUps.push(request);
        return onFollowUp(request);
      }
      if (request.run.depth === 1) {
        executor.launch({ harness: AgentRunHarness.Codex, model: "controlled", cwd: root,
          task: "child", parentThreadId: `session-${request.run.id}` });
        return completed("child pending");
      }
      return onChild(request);
    },
  });
  executor.start();
  const parent = executor.launch({ harness: AgentRunHarness.Codex, model: "controlled", cwd: root, task: "parent" });
  return { state, executor, parent, followUps };
}

/** Restarts the daemon over a saved ledger and records every turn it launches. */
function restart(name: string, onLaunch: (request: AgentRunLaunchRequest) => AgentRunLaunchResult) {
  const state = openState(name);
  const launches: AgentRunLaunchRequest[] = [];
  const executor = new AgentRunExecutor(state, { tickMs: 10, logger: () => undefined,
    launcher: async (request) => { launches.push(request); return onLaunch(request); } });
  executor.start();
  return { state, executor, launches };
}

/** A completed parent under an executor that never launches, so the hook under test alone
 * creates the follow-up. `settle` claims the oldest queued run and finishes it. */
function quietParent(name: string, now?: () => number) {
  const state = openState(name);
  const executor = new AgentRunExecutor(state, { maxConcurrent: 0, logger: () => undefined,
    launcher: async () => { throw new Error("unexpected launch"); }, ...(now ? { now } : {}) });
  const queue = (task: string, parentThreadId?: string) =>
    executor.launch({ harness: AgentRunHarness.Codex, model: "controlled", cwd: root, task, parentThreadId });
  const settle = (status: AgentRunStatus.Completed, resultTail: string) => {
    const run = state.claimNextPendingAgentRun(99)!;
    return state.finishAgentRun(run.id, { status, resultTail, error: null })!;
  };
  const parent = queue("parent");
  state.claimNextPendingAgentRun(99);
  state.recordAgentRunActivity(parent.id, { childSessionId: "parent-session", acpxRecordId: parent.id });
  state.finishAgentRun(parent.id, { status: AgentRunStatus.Completed, resultTail: "parent done", error: null });
  const followUpOf = () => state.listAgentRuns().filter((run) => run.resumeOfRunId === parent.id);
  return { state, executor, parent, queue, settle, followUpOf };
}

try {
  const delivered = parentWithChild("delivered", async (request) => {
    request.onActivity({ promptSubmitted: true });
    return completed("parent saw child result");
  });
  await waitFor(() => delivered.followUps.length === 1);
  const followUp = delivered.followUps[0]!.run;
  const child = delivered.state.listAgentRuns().find((run) => run.task === "child")!;
  assert.equal(followUp.resumeOfRunId, delivered.parent.id);
  assert.equal(followUp.childSessionId, `session-${delivered.parent.id}`);
  assert.deepEqual(followUp.completionRunIds, [child.id]);
  assert.match(followUp.task, /CHILD_TOKEN_189/);
  assert.match(followUp.task, /untrusted/i);
  await waitFor(() => delivered.state.agentRunById(followUp.id)?.status === AgentRunStatus.Completed);
  delivered.executor.sweepLostRuns();
  assert.equal(delivered.followUps.length, 1, "duplicate terminal notifications do not repeat the continuation");
  await delivered.executor.stop();
  delivered.state.close();
  const replay = restart("delivered", () => completed("unexpected replay"));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(replay.launches.length, 0, "restart does not replay a submitted follow-up");
  await replay.executor.stop();
  replay.state.close();

  const childStopped = parentWithChild("child-stopped", async () => completed("unused"), heldUntilStop);
  await waitFor(() => childStopped.state.listAgentRuns().some((run) => run.task === "child" && run.status === AgentRunStatus.Running)
    && childStopped.state.agentRunById(childStopped.parent.id)?.status === AgentRunStatus.Completed);
  await childStopped.executor.stop();
  childStopped.state.close();
  const resumedAtStart = restart("child-stopped", () => completed("parent handled the stopped child"));
  await waitFor(() => resumedAtStart.launches.length === 1);
  assert.equal(resumedAtStart.launches[0]!.run.resumeOfRunId, childStopped.parent.id,
    "restart continues a parent whose child the stop interrupted");
  assert.match(resumedAtStart.launches[0]!.run.task, /interrupted/);
  await resumedAtStart.executor.stop();
  resumedAtStart.state.close();

  const interrupted = parentWithChild("interrupted", heldUntilStop);
  await waitFor(() => interrupted.followUps.length === 1);
  const stalled = interrupted.followUps[0]!.run;
  await interrupted.executor.stop();
  assert.equal(interrupted.state.agentRunById(stalled.id)?.status, AgentRunStatus.Interrupted);
  interrupted.state.close();
  const recovered = restart("interrupted", () => ({ status: AgentRunStatus.Failed, resultText: "", error: "startup unavailable" }));
  await waitFor(() => recovered.launches.length === 1);
  const retry = recovered.launches[0]!.run;
  assert.equal(retry.retryOfRunId, stalled.id, "restart retries the interrupted follow-up once");
  assert.deepEqual(retry.completionRunIds, stalled.completionRunIds);
  assert.match(retry.task, /CHILD_TOKEN_189/);
  await waitFor(() => recovered.state.agentRunById(retry.id)?.status === AgentRunStatus.Failed);
  const corrected = recovered.executor.resume(retry.id, "CORRECTED_INSTRUCTIONS_189");
  assert.deepEqual(corrected.completionRunIds, stalled.completionRunIds, "resume keeps the undelivered receipt");
  assert.match(corrected.task, /^CORRECTED_INSTRUCTIONS_189\n\nPending child completion evidence/);
  assert.match(corrected.task, /CHILD_TOKEN_189/);
  await recovered.executor.stop();
  recovered.state.close();

  const fleet = quietParent("fleet");
  const finished = Array.from({ length: 20 }, (_, index) => {
    fleet.queue(`child ${index}`, "parent-session");
    return fleet.settle(AgentRunStatus.Completed, `RESULT_${index}_` + "r".repeat(4_000));
  });
  const queued = fleet.queue("queued child", "parent-session");
  await fleet.executor.cancel(queued.id);
  const [batch] = fleet.followUpOf();
  assert.ok(batch, "cancelling the last queued child continues the parent");
  assert.deepEqual([...batch.completionRunIds].sort(), [...finished.map(({ id }) => id), queued.id].sort(),
    "the follow-up records a receipt for every child, including those its evidence omits");
  assert.ok(JSON.parse(batch.task.split("\n\n")[1]!).omitted > 0, "the batch exceeds the evidence budget");
  fleet.state.claimNextPendingAgentRun(99);
  fleet.state.recordAgentRunActivity(batch.id, { promptSubmitted: true });
  fleet.state.finishAgentRun(batch.id, { status: AgentRunStatus.Completed, resultTail: "handled", error: null });
  await fleet.executor.stop();
  const fleetRestart = new AgentRunExecutor(fleet.state, { maxConcurrent: 0, logger: () => undefined,
    launcher: async () => { throw new Error("unexpected launch"); } });
  fleetRestart.start();
  await fleetRestart.stop();
  assert.equal(fleet.followUpOf().length, 1, "restart owes nothing for children the batch received");
  fleet.state.close();

  const swept = quietParent("swept", () => Date.parse("2026-10-17T00:00:00.000Z"));
  const stale = swept.queue("stale child", "parent-session");
  swept.state.claimNextPendingAgentRun(99);
  swept.executor.sweepLostRuns();
  assert.equal(swept.state.agentRunById(stale.id)?.status, AgentRunStatus.Lost);
  assert.deepEqual(swept.followUpOf().map(({ completionRunIds }) => completionRunIds), [[stale.id]],
    "the lost sweep continues the parent with the lost child");
  await swept.executor.stop();
  swept.state.close();
  process.stdout.write("ok - the executor applies nested follow-ups after child completion, cancel, lost sweep, restart, and resume\n");
} finally {
  if (priorHome === undefined) delete process.env.OO_HOME;
  else process.env.OO_HOME = priorHome;
  rmSync(root, { recursive: true, force: true });
}
