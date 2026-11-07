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
  process.stdout.write("ok - the executor applies nested follow-ups after child completion, on restart, and on resume\n");
} finally {
  if (priorHome === undefined) delete process.env.OO_HOME;
  else process.env.OO_HOME = priorHome;
  rmSync(root, { recursive: true, force: true });
}
