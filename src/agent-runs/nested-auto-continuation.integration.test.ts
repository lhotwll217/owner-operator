import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRunHarness, AgentRunStatus, type AgentRunLaunchRequest, type AgentRunLaunchResult } from "@owner-operator/core";
import { State } from "../state/state";
import { AgentRunExecutor } from "./executor";

const dir = mkdtempSync(join(tmpdir(), "oo-nested-auto-"));
const priorHome = process.env.OO_HOME;
process.env.OO_HOME = dir;
const state = new State(join(dir, "runs.db"));
const held = new Map<string, (result: AgentRunLaunchResult) => void>();
const resumed: AgentRunLaunchRequest[] = [];
let executor!: AgentRunExecutor;
const waitFor = async (condition: () => boolean): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, "automatic nested continuation reached expected state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
const launcher = async (request: AgentRunLaunchRequest): Promise<AgentRunLaunchResult> => {
  request.onActivity({ childSessionId: `session-${request.run.id}`, acpxRecordId: request.run.id });
  if (request.run.resumeOfRunId) {
    resumed.push(request);
    return { status: AgentRunStatus.Completed, resultText: "parent saw child result", error: null };
  }
  if (request.run.depth === 1) {
    executor.launch({ harness: AgentRunHarness.Codex, model: "controlled", cwd: dir,
      task: "child", parentThreadId: `session-${request.run.id}` });
    return { status: AgentRunStatus.Completed, resultText: "child pending", error: null };
  }
  return await new Promise<AgentRunLaunchResult>((resolve) => {
    held.set(request.run.id, resolve);
    request.signal.addEventListener("abort", () => resolve({
      status: AgentRunStatus.Cancelled, resultText: "", error: "aborted",
    }), { once: true });
  });
};
executor = new AgentRunExecutor(state, { launcher, tickMs: 10, logger: () => undefined });
try {
  executor.start();
  const parent = executor.launch({ harness: AgentRunHarness.Codex, model: "controlled", cwd: dir, task: "parent" });
  await waitFor(() => state.agentRunById(parent.id)?.status === AgentRunStatus.Completed && held.size === 1);
  const childId = [...held.keys()][0]!;
  held.get(childId)!({ status: AgentRunStatus.Completed, resultText: "CHILD_TOKEN_189", error: null });
  await waitFor(() => resumed.length === 1);
  assert.equal(resumed[0]!.run.resumeOfRunId, parent.id);
  assert.equal(resumed[0]!.run.childSessionId, `session-${parent.id}`);
  assert.match(resumed[0]!.run.task, /CHILD_TOKEN_189/);
  assert.match(resumed[0]!.run.task, /untrusted/i);
  await waitFor(() => state.agentRunById(resumed[0]!.run.id)?.status === AgentRunStatus.Completed);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(resumed.length, 1, "duplicate terminal notifications do not repeat the continuation");
  process.stdout.write("ok - parent automatically resumes its saved session after child completion\n");
} finally {
  await executor.stop();
  state.close();
  if (priorHome === undefined) delete process.env.OO_HOME;
  else process.env.OO_HOME = priorHome;
  rmSync(dir, { recursive: true, force: true });
}
