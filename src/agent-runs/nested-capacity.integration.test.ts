import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRunHarness, AgentRunStatus, type AgentRunLaunchResult } from "@owner-operator/core";
import { State } from "../state/state";
import { AgentRunExecutor } from "./executor";

const dir = mkdtempSync(join(tmpdir(), "oo-nested-capacity-"));
const priorHome = process.env.OO_HOME;
process.env.OO_HOME = dir;
const state = new State(join(dir, "runs.db"));
const heldChildren = new Map<string, (result: AgentRunLaunchResult) => void>();
let executor!: AgentRunExecutor;
const waitFor = async (condition: () => boolean): Promise<void> => {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, "nested runs reached expected state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
executor = new AgentRunExecutor(state, {
  logger: () => undefined,
  launcher: async (request) => {
    request.onActivity({ childSessionId: `session-${request.run.id}`, acpxRecordId: request.run.id });
    if (request.run.depth === 1) {
      executor.launch({ harness: AgentRunHarness.Codex, model: "controlled", task: "child", cwd: dir,
        parentThreadId: `session-${request.run.id}` });
      return { status: AgentRunStatus.Completed, resultText: "child pending; continue later", error: null };
    }
    return await new Promise<AgentRunLaunchResult>((resolve) => {
      heldChildren.set(request.run.id, resolve);
      request.signal.addEventListener("abort", () => resolve({
        status: AgentRunStatus.Cancelled, resultText: "", error: "cancelled",
      }), { once: true });
    });
  },
});
try {
  const parents = Array.from({ length: 50 }, () => executor.launch({
    harness: AgentRunHarness.Codex, model: "controlled", task: "parent", cwd: dir,
  }));
  await waitFor(() => parents.every((run) => state.agentRunById(run.id)?.status === AgentRunStatus.Completed));
  await waitFor(() => heldChildren.size === 50);
  const children = state.listAgentRuns().filter((run) => run.depth === 2);
  assert.equal(children.length, 50);
  assert.equal(children.filter((run) => run.status === AgentRunStatus.Running).length, 50);
  assert.ok(children.every((run) => parents.some((parent) => run.parentThreadId === `session-${parent.id}`)));
  heldChildren.get(children[0]!.id)!({ status: AgentRunStatus.Completed, resultText: "child result", error: null });
  await waitFor(() => state.agentRunById(children[0]!.id)?.status === AgentRunStatus.Completed);
  process.stdout.write("ok - 50 parent turns yield their slots; 50 linked children start within the cap\n");
} finally {
  await executor.stop();
  state.close();
  if (priorHome === undefined) delete process.env.OO_HOME;
  else process.env.OO_HOME = priorHome;
  rmSync(dir, { recursive: true, force: true });
}
