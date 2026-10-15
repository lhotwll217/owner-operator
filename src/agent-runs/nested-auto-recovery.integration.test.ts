import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRunHarness, AgentRunStatus, type AgentRunLaunchRequest, type AgentRunLaunchResult } from "@owner-operator/core";
import { State } from "../state/state";
import { AgentRunExecutor, NESTED_COMPLETION_TASK_MAX_BYTES } from "./executor";

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

  const overlapDir = join(root, "overlap");
  const overlapState = new State(join(overlapDir, "state.db"), {
    now: () => "2026-10-16T00:00:03.000Z",
  });
  let completeChild!: (result: AgentRunLaunchResult) => void;
  let completeParentTurn!: (result: AgentRunLaunchResult) => void;
  const delivered: AgentRunLaunchRequest[] = [];
  let overlap!: AgentRunExecutor;
  overlap = new AgentRunExecutor(overlapState, { tickMs: 10, logger: () => undefined,
    launcher: async (request) => {
      request.onActivity({ childSessionId: request.run.childSessionId ?? `session-${request.run.id}`,
        acpxRecordId: request.run.acpxRecordId ?? request.run.id });
      if (request.run.task === "independent parent turn") {
        return await new Promise<AgentRunLaunchResult>((resolve) => {
          completeParentTurn = resolve;
          held(request, resolve);
        });
      }
      if (request.run.resumeOfRunId) {
        delivered.push(request);
        return completed("handled late child");
      }
      if (request.run.depth === 1) {
        overlap.launch({ harness: AgentRunHarness.Codex, model: "controlled", cwd: overlapDir,
          task: "child", parentThreadId: `session-${request.run.id}` });
        return completed("child pending");
      }
      return await new Promise<AgentRunLaunchResult>((resolve) => {
        completeChild = resolve;
        held(request, resolve);
      });
    },
  });
  overlap.start();
  const firstParentTurn = overlap.launch({ harness: AgentRunHarness.Codex, model: "controlled", cwd: overlapDir, task: "parent" });
  await waitFor(() => overlapState.agentRunById(firstParentTurn.id)?.status === AgentRunStatus.Completed && !!completeChild);
  const activeParentTurn = overlap.resume(firstParentTurn.id, "independent parent turn");
  await waitFor(() => !!completeParentTurn);
  completeChild(completed("LATE_CHILD_189"));
  await waitFor(() => overlapState.listAgentRuns().some((run) => run.task === "child" && run.status === AgentRunStatus.Completed));
  assert.equal(delivered.length, 0, "completion waits for the active parent turn");
  completeParentTurn(completed("independent work done"));
  await waitFor(() => delivered.length === 1);
  assert.equal(delivered[0]!.run.resumeOfRunId, activeParentTurn.id);
  assert.match(delivered[0]!.run.task, /LATE_CHILD_189/);
  await overlap.stop();
  overlapState.close();
  const reopenedOverlap = new State(join(overlapDir, "state.db"), {
    now: () => "2026-10-16T00:00:03.000Z",
  });
  const repeated: AgentRunLaunchRequest[] = [];
  const overlapRestart = new AgentRunExecutor(reopenedOverlap, { tickMs: 10, logger: () => undefined,
    launcher: async (request) => { repeated.push(request); return completed("unexpected repeat"); },
  });
  overlapRestart.start();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(repeated.length, 0, "equal timestamps do not replay a delivered result after restart");
  await overlapRestart.stop();
  reopenedOverlap.close();

  const budgetDir = join(root, "budget");
  const budgetState = new State(join(budgetDir, "state.db"));
  let budgetFollowUp: AgentRunLaunchRequest | undefined;
  let budget!: AgentRunExecutor;
  budget = new AgentRunExecutor(budgetState, { tickMs: 10, logger: () => undefined,
    launcher: async (request) => {
      request.onActivity({ childSessionId: request.run.childSessionId ?? `session-${request.run.id}`,
        acpxRecordId: request.run.acpxRecordId ?? request.run.id });
      if (request.run.resumeOfRunId) {
        budgetFollowUp = request;
        return completed("all children reviewed");
      }
      if (request.run.depth === 1) {
        for (let index = 0; index < 80; index++) {
          budget.launch({ harness: AgentRunHarness.Codex, model: "controlled", cwd: budgetDir,
            task: `child-${index}`, parentThreadId: `session-${request.run.id}` });
        }
        return completed("dependent work pending");
      }
      const index = Number(request.run.task.slice("child-".length));
      return index % 3 === 0
        ? { status: AgentRunStatus.Failed, resultText: "", error: `FAILED_${index}_` + "e".repeat(4_000) }
        : completed(`RESULT_${index}_` + "r".repeat(20_000));
    },
  });
  budget.start();
  const budgetParent = budget.launch({ harness: AgentRunHarness.Codex, model: "controlled", cwd: budgetDir,
    task: "parent" });
  await waitFor(() => budgetFollowUp !== undefined);
  const budgetContinuation = budgetFollowUp!;
  assert.equal(budgetContinuation.run.resumeOfRunId, budgetParent.id);
  assert.ok(Buffer.byteLength(budgetContinuation.run.task, "utf8") <= NESTED_COMPLETION_TASK_MAX_BYTES);
  const evidence = JSON.parse(budgetContinuation.run.task.split("\n\n")[1]!) as {
    totalChildren: number; outcomes: Record<string, number>; details: Array<{ outcome: string }>;
    omitted: number; retrieval: { parentRunId: string; list: string; get: string };
  };
  assert.equal(evidence.totalChildren, 80);
  assert.equal(evidence.outcomes.failed, 27);
  assert.equal(evidence.outcomes.completed, 53);
  assert.ok(evidence.omitted > 0);
  assert.equal(evidence.omitted + evidence.details.length, 80);
  assert.equal(evidence.details[0]?.outcome, AgentRunStatus.Failed);
  assert.equal(evidence.retrieval.parentRunId, budgetParent.id);
  assert.match(evidence.retrieval.list, /runs list --parent/);
  assert.match(evidence.retrieval.get, /runs get/);
  assert.equal(budgetContinuation.run.completionRunIds.length, 80);
  await budget.stop();
  budgetState.close();
  process.stdout.write("ok - active parent, multiple children, failure, dedupe, restart, fixed-clock overlap, and bounded evidence\n");
} finally {
  if (priorHome === undefined) delete process.env.OO_HOME;
  else process.env.OO_HOME = priorHome;
  rmSync(root, { recursive: true, force: true });
}
