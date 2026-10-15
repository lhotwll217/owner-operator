import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRunHarness, AgentRunStatus, type AgentRunLaunchRequest, type AgentRunLaunchResult } from "@owner-operator/core";
import { State } from "../state/state";
import { AgentRunExecutor } from "./executor";

const root = mkdtempSync(join(tmpdir(), "oo-nested-auto-recovery-"));
const priorHome = process.env.OO_HOME;
process.env.OO_HOME = root;
const waitFor = async (condition: () => boolean): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, "nested recovery reached expected state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
const completed = (text: string): AgentRunLaunchResult =>
  ({ status: AgentRunStatus.Completed, resultText: text, error: null });
const held = (request: AgentRunLaunchRequest, resolve: (result: AgentRunLaunchResult) => void): void => {
  request.signal.addEventListener("abort", () => resolve({
    status: AgentRunStatus.Cancelled, resultText: "", error: "aborted",
  }), { once: true });
};

try {
  const dir = join(root, "active");
  let tick = 0;
  const state = new State(join(dir, "state.db"), {
    now: () => new Date(Date.UTC(2026, 9, 16, 0, 0, 0, tick++)).toISOString(),
  });
  const children = new Map<string, (result: AgentRunLaunchResult) => void>();
  const continuations: AgentRunLaunchRequest[] = [];
  let releaseParent!: () => void;
  let executor!: AgentRunExecutor;
  executor = new AgentRunExecutor(state, { tickMs: 10, logger: () => undefined,
    launcher: async (request) => {
      request.onActivity({ childSessionId: request.run.childSessionId ?? `session-${request.run.id}`,
        acpxRecordId: request.run.acpxRecordId ?? request.run.id });
      if (request.run.resumeOfRunId) {
        continuations.push(request);
        return completed("parent completed dependent work");
      }
      if (request.run.depth === 1) {
        for (const task of ["first", "second"]) {
          executor.launch({ harness: AgentRunHarness.Codex, model: "controlled", cwd: dir,
            task, parentThreadId: `session-${request.run.id}` });
        }
        await new Promise<void>((resolve) => { releaseParent = resolve; });
        return completed("children pending");
      }
      return await new Promise<AgentRunLaunchResult>((resolve) => {
        children.set(request.run.task, resolve);
        held(request, resolve);
      });
    },
  });
  executor.start();
  const parent = executor.launch({ harness: AgentRunHarness.Codex, model: "controlled", cwd: dir, task: "parent" });
  await waitFor(() => children.size === 2);
  children.get("first")!({ status: AgentRunStatus.Failed, resultText: "", error: "CHILD_FAILED_189" });
  await waitFor(() => state.listAgentRuns().some((run) => run.task === "first" && run.status === AgentRunStatus.Failed));
  assert.equal(continuations.length, 0, "a child completion cannot interrupt an active parent turn");
  releaseParent();
  await waitFor(() => state.agentRunById(parent.id)?.status === AgentRunStatus.Completed);
  assert.equal(continuations.length, 0, "the parent waits for all children before continuing");
  children.get("second")!(completed("CHILD_OK_189"));
  await waitFor(() => continuations.length === 1);
  assert.equal(continuations[0]!.run.resumeOfRunId, parent.id);
  assert.equal(continuations[0]!.run.childSessionId, `session-${parent.id}`);
  assert.match(continuations[0]!.run.task, /CHILD_FAILED_189/);
  assert.match(continuations[0]!.run.task, /CHILD_OK_189/);
  assert.match(continuations[0]!.run.task, /untrusted/i);
  await waitFor(() => state.agentRunById(continuations[0]!.run.id)?.status === AgentRunStatus.Completed);
  executor.sweepLostRuns();
  assert.equal(continuations.length, 1, "reconciliation does not duplicate a completed follow-up");
  await executor.stop();
  state.close();
  const reopened = new State(join(dir, "state.db"));
  const duplicateLaunches: AgentRunLaunchRequest[] = [];
  const duplicateCheck = new AgentRunExecutor(reopened, { tickMs: 10, logger: () => undefined,
    launcher: async (request) => {
      duplicateLaunches.push(request);
      return completed("unexpected duplicate");
    },
  });
  duplicateCheck.start();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(duplicateLaunches.length, 0, "restart does not replay an acknowledged follow-up");
  await duplicateCheck.stop();
  reopened.close();

  const restartDir = join(root, "restart");
  tick = 0;
  const restartState = new State(join(restartDir, "state.db"), {
    now: () => new Date(Date.UTC(2026, 9, 16, 0, 0, 1, tick++)).toISOString(),
  });
  let first!: AgentRunExecutor;
  let releaseChild!: (result: AgentRunLaunchResult) => void;
  first = new AgentRunExecutor(restartState, { tickMs: 10, logger: () => undefined,
    launcher: async (request) => {
      request.onActivity({ childSessionId: request.run.childSessionId ?? `session-${request.run.id}`,
        acpxRecordId: request.run.acpxRecordId ?? request.run.id });
      if (request.run.depth === 1) {
        first.launch({ harness: AgentRunHarness.Codex, model: "controlled", cwd: restartDir,
          task: "child", parentThreadId: `session-${request.run.id}` });
        return completed("child pending");
      }
      return await new Promise<AgentRunLaunchResult>((resolve) => {
        releaseChild = resolve;
        held(request, resolve);
      });
    },
  });
  first.start();
  const original = first.launch({ harness: AgentRunHarness.Codex, model: "controlled", cwd: restartDir, task: "parent" });
  await waitFor(() => restartState.agentRunById(original.id)?.status === AgentRunStatus.Completed && !!releaseChild);
  await first.stop();
  assert.equal(restartState.listAgentRuns().filter((run) => run.resumeOfRunId === original.id).length, 0);
  restartState.close();
  const recoveredState = new State(join(restartDir, "state.db"));
  const afterRestart: AgentRunLaunchRequest[] = [];
  const second = new AgentRunExecutor(recoveredState, { tickMs: 10, logger: () => undefined,
    launcher: async (request) => {
      afterRestart.push(request);
      request.onActivity({ childSessionId: request.run.childSessionId!, acpxRecordId: request.run.acpxRecordId! });
      return completed("recovered parent work");
    },
  });
  second.start();
  await waitFor(() => afterRestart.length === 1);
  assert.equal(afterRestart[0]!.run.resumeOfRunId, original.id);
  assert.equal(afterRestart[0]!.run.childSessionId, `session-${original.id}`);
  assert.match(afterRestart[0]!.run.task, /interrupted/);
  await second.stop();
  recoveredState.close();

  const chainDir = join(root, "chain");
  tick = 0;
  const chainState = new State(join(chainDir, "state.db"), {
    now: () => new Date(Date.UTC(2026, 9, 16, 0, 0, 2, tick++)).toISOString(),
  });
  const chainContinuations: AgentRunLaunchRequest[] = [];
  let finishGrandchild!: (result: AgentRunLaunchResult) => void;
  let chain!: AgentRunExecutor;
  chain = new AgentRunExecutor(chainState, { tickMs: 10, logger: () => undefined,
    launcher: async (request) => {
      request.onActivity({ childSessionId: request.run.childSessionId ?? `session-${request.run.id}`,
        acpxRecordId: request.run.acpxRecordId ?? request.run.id });
      if (request.run.resumeOfRunId) {
        chainContinuations.push(request);
        return completed(request.run.depth === 2 ? "FINAL_CHILD_189" : "FINAL_PARENT_189");
      }
      if (request.run.depth < 3) {
        chain.launch({ harness: AgentRunHarness.Codex, model: "controlled", cwd: chainDir,
          task: `depth ${request.run.depth + 1}`, parentThreadId: `session-${request.run.id}` });
        return completed("nested work pending");
      }
      return await new Promise<AgentRunLaunchResult>((resolve) => {
        finishGrandchild = resolve;
        held(request, resolve);
      });
    },
  });
  chain.start();
  const rootRun = chain.launch({ harness: AgentRunHarness.Codex, model: "controlled", cwd: chainDir, task: "root" });
  await waitFor(() => !!finishGrandchild && chainState.agentRunById(rootRun.id)?.status === AgentRunStatus.Completed);
  assert.equal(chainContinuations.length, 0);
  finishGrandchild(completed("GRANDCHILD_189"));
  await waitFor(() => chainContinuations.length === 2);
  assert.deepEqual(chainContinuations.map(({ run }) => run.depth), [2, 1]);
  assert.match(chainContinuations[0]!.run.task, /GRANDCHILD_189/);
  assert.match(chainContinuations[1]!.run.task, /FINAL_CHILD_189/);
  assert.doesNotMatch(chainContinuations[1]!.run.task, /nested work pending/);
  await chain.stop();
  chainState.close();
  process.stdout.write("ok - active parent, multiple children, failure, dedupe, restart, and nested dependency chain\n");
} finally {
  if (priorHome === undefined) delete process.env.OO_HOME;
  else process.env.OO_HOME = priorHome;
  rmSync(root, { recursive: true, force: true });
}
