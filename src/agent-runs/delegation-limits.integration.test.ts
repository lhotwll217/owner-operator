import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRunHarness, AgentRunStatus, type AgentRunLaunchRequest, type AgentRunLaunchResult } from "@owner-operator/core";
import { State } from "../state/state";
import { AgentRunExecutor } from "./executor";

const dir = mkdtempSync(join(tmpdir(), "oo-delegation-limits-"));
const priorHome = process.env.OO_HOME;
process.env.OO_HOME = dir;
const state = new State(join(dir, "runs.db"));
const started = new Map<string, (result: AgentRunLaunchResult) => void>();
const launcher = (request: AgentRunLaunchRequest): Promise<AgentRunLaunchResult> =>
  new Promise((resolve) => {
    request.onActivity({ childSessionId: `child-${request.run.id}`, acpxRecordId: request.run.id });
    started.set(request.run.id, resolve);
    request.signal.addEventListener("abort", () => resolve({
      status: AgentRunStatus.Cancelled, resultText: "", error: "cancelled",
    }), { once: true });
  });
const executor = new AgentRunExecutor(state, { launcher, logger: () => undefined });
assert.throws(() => new AgentRunExecutor(state, { launcher, maxConcurrent: 51 }),
  /maxConcurrent must be an integer in 0..50/);
const waitFor = async (condition: () => boolean): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, "delegated launcher reached expected capacity");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

try {
  for (let depth = 1; depth <= 4; depth++) {
    const ancestor = state.createAgentRun({
      harness: AgentRunHarness.Codex, task: `ancestor ${depth}`, cwd: dir,
      depth, timeoutSeconds: 60, childSessionId: `ancestor-${depth}`,
      ...(depth > 1 ? { parentThreadId: `ancestor-${depth - 1}` } : {}),
    });
    state.claimNextPendingAgentRun(1);
    state.finishAgentRun(ancestor.id, { status: AgentRunStatus.Completed, resultTail: null, error: null });
  }
  const fifthDepth = executor.launch({
    harness: AgentRunHarness.Codex, model: "test-model", task: "fifth depth", cwd: dir,
    parentThreadId: "ancestor-4",
  });
  assert.equal(fifthDepth.depth, 5);
  assert.equal(fifthDepth.parentThreadId, "ancestor-4");
  await waitFor(() => started.has(fifthDepth.id));
  assert.throws(() => executor.launch({
    harness: AgentRunHarness.Codex, model: "test-model", task: "sixth depth", cwd: dir,
    parentThreadId: `child-${fifthDepth.id}`,
  }), /delegation depth 6 exceeds the cap of 5/);

  const runs = Array.from({ length: 50 }, (_, index) => executor.launch({
    harness: AgentRunHarness.Codex, model: "test-model", task: `capacity ${index}`, cwd: dir,
  }));
  await waitFor(() => started.size === 50);
  assert.equal(state.listAgentRuns().filter((run) => run.status === AgentRunStatus.Running).length, 50);
  assert.equal(state.agentRunById(runs[49].id)?.status, AgentRunStatus.Pending);
  assert.equal(started.has(runs[49].id), false);
  started.get(fifthDepth.id)!({ status: AgentRunStatus.Completed, resultText: "done", error: null });
  await waitFor(() => started.has(runs[49].id));
  assert.equal(state.agentRunById(runs[49].id)?.status, AgentRunStatus.Running);
  assert.equal(state.listAgentRuns().filter((run) => run.status === AgentRunStatus.Running).length, 50);
  assert.equal(state.agentRunById(fifthDepth.id)?.status, AgentRunStatus.Completed);
  process.stdout.write("ok - depth five accepted, six rejected, and the 51st run waits for a daemon slot\n");
} finally {
  await executor.stop();
  state.close();
  if (priorHome === undefined) delete process.env.OO_HOME;
  else process.env.OO_HOME = priorHome;
  rmSync(dir, { recursive: true, force: true });
}
