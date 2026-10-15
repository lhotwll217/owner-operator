import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRunHarness, AgentRunStatus, type AgentRunLaunchRequest, type AgentRunLaunchResult } from "@owner-operator/core";
import { State } from "../state/state";
import { AgentRunExecutor } from "./executor";

const root = mkdtempSync(join(tmpdir(), "oo-nested-delivery-recovery-"));
const priorHome = process.env.OO_HOME;
process.env.OO_HOME = root;
const completed = (text: string): AgentRunLaunchResult =>
  ({ status: AgentRunStatus.Completed, resultText: text, error: null });
const waitFor = async (condition: () => boolean): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, "expected nested delivery transition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

async function scenario(name: string, onFollowUp: (request: AgentRunLaunchRequest) => Promise<AgentRunLaunchResult>) {
  const dir = join(root, name);
  const state = new State(join(dir, "state.db"));
  const followUps: AgentRunLaunchRequest[] = [];
  let executor!: AgentRunExecutor;
  executor = new AgentRunExecutor(state, { tickMs: 10, logger: () => undefined,
    launcher: async (request) => {
      request.onActivity({ childSessionId: request.run.childSessionId ?? `session-${request.run.id}`,
        acpxRecordId: request.run.acpxRecordId ?? request.run.id });
      if (request.run.resumeOfRunId || request.run.retryOfRunId) {
        followUps.push(request);
        return onFollowUp(request);
      }
      if (request.run.depth === 1) {
        executor.launch({ harness: AgentRunHarness.Codex, model: "controlled", cwd: dir,
          task: "child", parentThreadId: `session-${request.run.id}` });
        return completed("child pending");
      }
      return completed("CHILD_EVIDENCE_189");
    },
  });
  executor.start();
  const parent = executor.launch({ harness: AgentRunHarness.Codex, model: "controlled", cwd: dir, task: "parent" });
  await waitFor(() => followUps.length === 1);
  const child = state.listAgentRuns().find((run) => run.task === "child")!;
  const automatic = followUps[0]!.run;
  assert.equal(automatic.resumeOfRunId, parent.id);
  assert.deepEqual(automatic.completionRunIds, [child.id]);
  return { dir, state, executor, parent, child, automatic, followUps };
}

try {
  const failed = await scenario("pre-submit-failure", async () => ({
    status: AgentRunStatus.Failed, resultText: "", error: "startup unavailable",
  }));
  await waitFor(() => failed.state.agentRunById(failed.automatic.id)?.status === AgentRunStatus.Failed);
  assert.equal(failed.state.agentRunById(failed.automatic.id)?.promptSubmitted, false);
  const retried = failed.executor.retry(failed.automatic.id);
  assert.deepEqual(retried.completionRunIds, [failed.child.id], "retry retains the undelivered receipt");
  assert.match(retried.task, /CHILD_EVIDENCE_189/);
  assert.equal(retried.childSessionId, failed.automatic.childSessionId);
  assert.equal(retried.acpxRecordId, failed.automatic.acpxRecordId);
  await failed.executor.stop();
  failed.state.close();

  const corrected = await scenario("corrected-resume", async () => ({
    status: AgentRunStatus.Failed, resultText: "", error: "startup unavailable",
  }));
  await waitFor(() => corrected.state.agentRunById(corrected.automatic.id)?.status === AgentRunStatus.Failed);
  const resumed = corrected.executor.resume(corrected.automatic.id, "CORRECTED_INSTRUCTIONS_189");
  assert.deepEqual(resumed.completionRunIds, [corrected.child.id], "resume retains undelivered receipt");
  assert.equal(resumed.childSessionId, corrected.automatic.childSessionId);
  assert.equal(resumed.acpxRecordId, corrected.automatic.acpxRecordId);
  assert.match(resumed.task, /CORRECTED_INSTRUCTIONS_189/);
  assert.match(resumed.task, /CHILD_EVIDENCE_189/, "corrected instructions retain bounded child evidence");
  await corrected.executor.stop();
  corrected.state.close();

  const interrupted = await scenario("interrupted", async (request) => await new Promise((resolve) => {
    request.signal.addEventListener("abort", () => resolve({
      status: AgentRunStatus.Cancelled, resultText: "", error: "aborted",
    }), { once: true });
  }));
  await interrupted.executor.stop();
  assert.equal(interrupted.state.agentRunById(interrupted.automatic.id)?.status, AgentRunStatus.Interrupted);
  interrupted.state.close();
  const recoveredState = new State(join(interrupted.dir, "state.db"));
  const recoveredLaunches: AgentRunLaunchRequest[] = [];
  const recovered = new AgentRunExecutor(recoveredState, { tickMs: 10, logger: () => undefined,
    launcher: async (request) => {
      recoveredLaunches.push(request);
      request.onActivity({ promptSubmitted: true });
      return completed("recovered parent work");
    },
  });
  recovered.start();
  await waitFor(() => recoveredLaunches.length === 1);
  assert.equal(recoveredLaunches[0]!.run.retryOfRunId, interrupted.automatic.id);
  assert.equal(recoveredLaunches[0]!.run.childSessionId, interrupted.automatic.childSessionId);
  assert.equal(recoveredLaunches[0]!.run.acpxRecordId, interrupted.automatic.acpxRecordId);
  assert.deepEqual(recoveredLaunches[0]!.run.completionRunIds, [interrupted.child.id]);
  await waitFor(() => recoveredState.agentRunById(recoveredLaunches[0]!.run.id)?.status === AgentRunStatus.Completed);
  recovered.sweepLostRuns();
  assert.equal(recoveredLaunches.length, 1, "duplicate notifications do not repeat submitted evidence");
  const laterChild = recovered.launch({ harness: AgentRunHarness.Codex, model: "controlled", cwd: interrupted.dir,
    task: "later child", parentThreadId: interrupted.automatic.childSessionId });
  await waitFor(() => recoveredLaunches.length === 3);
  assert.equal(recoveredLaunches[1]!.run.id, laterChild.id);
  assert.deepEqual(recoveredLaunches[2]!.run.completionRunIds, [laterChild.id],
    "a later completion carries only new evidence after the earlier receipt was submitted");
  await waitFor(() => recoveredState.agentRunById(recoveredLaunches[2]!.run.id)?.status === AgentRunStatus.Completed);
  recovered.sweepLostRuns();
  assert.equal(recoveredLaunches.length, 3);
  await recovered.stop();
  recoveredState.close();
  const dedupeState = new State(join(interrupted.dir, "state.db"));
  const dedupeLaunches: AgentRunLaunchRequest[] = [];
  const dedupe = new AgentRunExecutor(dedupeState, { tickMs: 10, logger: () => undefined,
    launcher: async (request) => { dedupeLaunches.push(request); return completed("unexpected duplicate"); },
  });
  dedupe.start();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(dedupeLaunches.length, 0, "restart does not repeat submitted evidence");
  await dedupe.stop();
  dedupeState.close();

  const stalled = await scenario("retry-stalls", async (request) => await new Promise((resolve) => {
    request.signal.addEventListener("abort", () => resolve({
      status: AgentRunStatus.Cancelled, resultText: "", error: "aborted",
    }), { once: true });
  }));
  await stalled.executor.stop();
  stalled.state.close();
  const stalledState = new State(join(stalled.dir, "state.db"));
  const stalledLaunches: AgentRunLaunchRequest[] = [];
  const singleRetry = new AgentRunExecutor(stalledState, { tickMs: 10, logger: () => undefined,
    launcher: async (request) => {
      stalledLaunches.push(request);
      return { status: AgentRunStatus.Failed, resultText: "", error: "authentication unavailable" };
    },
  });
  singleRetry.start();
  await waitFor(() => stalledLaunches.length === 1
    && stalledState.agentRunById(stalledLaunches[0]!.run.id)?.status === AgentRunStatus.Failed);
  assert.equal(stalledLaunches[0]!.run.retryOfRunId, stalled.automatic.id);
  await singleRetry.stop();
  stalledState.close();
  const stalledAgainState = new State(join(stalled.dir, "state.db"));
  const unexpectedRetries: AgentRunLaunchRequest[] = [];
  const noLoop = new AgentRunExecutor(stalledAgainState, { tickMs: 10, logger: () => undefined,
    launcher: async (request) => { unexpectedRetries.push(request); return completed("unexpected retry"); },
  });
  noLoop.start();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(unexpectedRetries.length, 0, "failed infrastructure retry needs explicit recovery, not a loop");
  await noLoop.stop();
  stalledAgainState.close();

  const cancelled = await scenario("cancelled", async (request) => await new Promise((resolve) => {
    request.signal.addEventListener("abort", () => resolve({
      status: AgentRunStatus.Cancelled, resultText: "", error: "aborted",
    }), { once: true });
  }));
  await cancelled.executor.cancel(cancelled.automatic.id);
  assert.equal(cancelled.state.agentRunById(cancelled.automatic.id)?.status, AgentRunStatus.Cancelled);
  await cancelled.executor.stop();
  cancelled.state.close();
  const cancelledState = new State(join(cancelled.dir, "state.db"));
  const cancelledLaunches: AgentRunLaunchRequest[] = [];
  const afterCancel = new AgentRunExecutor(cancelledState, { tickMs: 10, logger: () => undefined,
    launcher: async (request) => {
      cancelledLaunches.push(request);
      request.onActivity({ promptSubmitted: true });
      return completed("explicitly continued");
    },
  });
  afterCancel.start();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(cancelledLaunches.length, 0, "owner cancellation never restarts automatically");
  const explicit = afterCancel.resume(cancelled.automatic.id, "EXPLICIT_CORRECTION_189");
  assert.deepEqual(explicit.completionRunIds, [cancelled.child.id]);
  assert.match(explicit.task, /CHILD_EVIDENCE_189/);
  await waitFor(() => cancelledLaunches.length === 1);
  await afterCancel.stop();
  cancelledState.close();

  const queuedDir = join(root, "queued");
  const queuedState = new State(join(queuedDir, "state.db"));
  let blockerStarted = false;
  let queued!: AgentRunExecutor;
  queued = new AgentRunExecutor(queuedState, { tickMs: 10, maxConcurrent: 1, logger: () => undefined,
    launcher: async (request) => {
      request.onActivity({ childSessionId: request.run.childSessionId ?? `session-${request.run.id}`,
        acpxRecordId: request.run.acpxRecordId ?? request.run.id });
      if (request.run.task === "blocker") {
        blockerStarted = true;
        return await new Promise((resolve) => {
          request.signal.addEventListener("abort", () => resolve({
            status: AgentRunStatus.Cancelled, resultText: "", error: "aborted",
          }), { once: true });
        });
      }
      if (request.run.task === "parent") {
        queued.launch({ harness: AgentRunHarness.Codex, model: "controlled", cwd: queuedDir,
          task: "child", parentThreadId: `session-${request.run.id}` });
        queued.launch({ harness: AgentRunHarness.Codex, model: "controlled", cwd: queuedDir,
          task: "blocker" });
        return completed("child pending");
      }
      return completed("QUEUED_CHILD_EVIDENCE_189");
    },
  });
  queued.start();
  const queuedParent = queued.launch({ harness: AgentRunHarness.Codex, model: "controlled", cwd: queuedDir,
    task: "parent" });
  await waitFor(() => blockerStarted && queuedState.listAgentRuns().some((run) =>
    run.resumeOfRunId === queuedParent.id && run.status === AgentRunStatus.Pending));
  const pendingFollowUp = queuedState.listAgentRuns().find((run) => run.resumeOfRunId === queuedParent.id)!;
  assert.equal(pendingFollowUp.promptSubmitted, false);
  assert.equal(pendingFollowUp.completionRunIds.length, 1);
  queued.sweepLostRuns();
  assert.equal(queuedState.listAgentRuns().filter((run) => run.resumeOfRunId === queuedParent.id).length, 1);
  await queued.stop();
  queuedState.close();
  const queuedRestartState = new State(join(queuedDir, "state.db"));
  const queuedLaunches: AgentRunLaunchRequest[] = [];
  const queuedRestart = new AgentRunExecutor(queuedRestartState, { tickMs: 10, logger: () => undefined,
    launcher: async (request) => {
      queuedLaunches.push(request);
      request.onActivity({ promptSubmitted: true });
      return completed("delivered after capacity freed");
    },
  });
  queuedRestart.start();
  await waitFor(() => queuedLaunches.length === 1);
  assert.equal(queuedLaunches[0]!.run.id, pendingFollowUp.id);
  await waitFor(() => queuedRestartState.agentRunById(pendingFollowUp.id)?.status === AgentRunStatus.Completed);
  assert.equal(queuedRestartState.listAgentRuns().filter((run) => run.resumeOfRunId === queuedParent.id).length, 1);
  await queuedRestart.stop();
  queuedRestartState.close();

  process.stdout.write("ok - nested delivery survives queued, failed, interrupted, cancelled, retried, and corrected turns without duplicates\n");
} finally {
  if (priorHome === undefined) delete process.env.OO_HOME;
  else process.env.OO_HOME = priorHome;
  rmSync(root, { recursive: true, force: true });
}
