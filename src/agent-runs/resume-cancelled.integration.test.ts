import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRunHarness, AgentRunStatus, type AgentRunLaunchRequest } from "@owner-operator/core";
import { State } from "../state/state";
import { AgentRunExecutor } from "./executor";
import { deriveParentAgentStateWithEnvironment } from "./agent-state-projection";

const dir = mkdtempSync(join(tmpdir(), "oo-resume-cancelled-"));
const previousHome = process.env.OO_HOME;
process.env.OO_HOME = dir;
const state = new State(join(dir, "state.db"));
const requests: AgentRunLaunchRequest[] = [];
const executor = new AgentRunExecutor(state, {
  maxConcurrent: 1,
  launcher: async (request) => {
    requests.push(request);
    if (request.turnIntent.kind === "resume") {
      return { status: AgentRunStatus.Completed, resultText: "continued", error: null };
    }
    request.onActivity({ childSessionId: "child", acpxRecordId: "record" });
    await new Promise<void>((resolve) => request.signal.addEventListener("abort", () => resolve(), { once: true }));
    return { status: AgentRunStatus.Cancelled, resultText: "partial", error: null };
  },
});
try {
  const original = executor.launch({
    harness: AgentRunHarness.Codex, task: "first task", cwd: dir, model: "test-model", effort: null,
  });
  const queued = executor.launch({
    harness: AgentRunHarness.Codex, task: "queued", cwd: dir, model: "test-model", effort: null,
  });
  await executor.cancel(queued.id);
  assert.throws(() => executor.resume(queued.id, "continue"), /no child session identity/);
  const cancelled = await executor.cancel(original.id);
  assert.equal(cancelled.status, AgentRunStatus.Cancelled);
  assert.equal(deriveParentAgentStateWithEnvironment([cancelled]).runs[0].canResume, true);
  const resumed = executor.resume(original.id, "continue with the revised task");
  assert.equal(resumed.resumeOfRunId, original.id);
  assert.equal(resumed.retryOfRunId, null);
  assert.equal(resumed.task, "continue with the revised task");
  for (const key of ["childSessionId", "acpxRecordId", "harness", "model", "effort", "cwd", "depth", "timeoutSeconds"] as const) {
    assert.equal(resumed[key], cancelled[key], key);
  }
  assert.deepEqual(requests[1].turnIntent, { kind: "resume", childSessionId: "child", acpxRecordId: "record" });
  assert.equal((await executor.wait(resumed.id, 5_000)).status, AgentRunStatus.Completed);
  assert.deepEqual(state.agentRunById(original.id), cancelled);
  assert.throws(() => executor.resume(original.id, "branch"), /already been resumed/);
  assert.throws(() => executor.retry(original.id), /not retryable/);
  process.stdout.write("ok - cancelled runs resume the same child; queued cancellations fail without identity\n");
} finally {
  await executor.stop();
  state.close();
  if (previousHome === undefined) delete process.env.OO_HOME;
  else process.env.OO_HOME = previousHome;
  rmSync(dir, { recursive: true, force: true });
}
