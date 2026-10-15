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
  await failed.executor.stop();
  failed.state.close();

  const corrected = await scenario("corrected-resume", async () => ({
    status: AgentRunStatus.Failed, resultText: "", error: "startup unavailable",
  }));
  await waitFor(() => corrected.state.agentRunById(corrected.automatic.id)?.status === AgentRunStatus.Failed);
  const resumed = corrected.executor.resume(corrected.automatic.id, "CORRECTED_INSTRUCTIONS_189");
  assert.deepEqual(resumed.completionRunIds, [corrected.child.id], "resume retains undelivered receipt");
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
  assert.deepEqual(recoveredLaunches[0]!.run.completionRunIds, [interrupted.child.id]);
  await waitFor(() => recoveredState.agentRunById(recoveredLaunches[0]!.run.id)?.status === AgentRunStatus.Completed);
  recovered.sweepLostRuns();
  assert.equal(recoveredLaunches.length, 1, "duplicate notifications do not repeat submitted evidence");
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

  process.stdout.write("ok - nested delivery receipts survive failure, retry, correction, interruption, restart, and cancellation\n");
} finally {
  if (priorHome === undefined) delete process.env.OO_HOME;
  else process.env.OO_HOME = priorHome;
  rmSync(root, { recursive: true, force: true });
}
