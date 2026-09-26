import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AcpRuntime } from "acpx/runtime";
import { AgentRunHarness, AgentRunStatus } from "@owner-operator/core";
import { State } from "../state/state";
import { AgentRunExecutor } from "./executor";
import { createAcpLauncher } from "./acp-launcher";
import { deriveParentAgentStateWithEnvironment } from "./agent-state-projection";

const dir = mkdtempSync(join(tmpdir(), "oo-resume-cancelled-"));
const previousHome = process.env.OO_HOME;
process.env.OO_HOME = dir;
const state = new State(join(dir, "state.db"));
let releaseSelection!: () => void;
let selectionReached!: () => void;
const selectionGate = new Promise<void>((resolve) => { releaseSelection = resolve; });
const selecting = new Promise<void>((resolve) => { selectionReached = resolve; });
let holdSelection = true;
let promptsSent = 0;
const runtime = {
  ensureSession: async ({ sessionKey }: { sessionKey: string }) => ({
    sessionKey, agentSessionId: `child-${sessionKey}`, acpxRecordId: sessionKey,
  }),
  getStatus: async () => {
    if (holdSelection) {
      selectionReached();
      await selectionGate;
    }
    return { models: { currentModelId: "test-model" }, details: { configOptions: [] } };
  },
  startTurn: ({ signal }: { signal: AbortSignal }) => {
    const aborted = signal.aborted;
    const promptStarted = aborted
      ? Promise.reject(new Error("ACP turn cancelled before prompt submission."))
      : Promise.resolve();
    void promptStarted.catch(() => {});
    if (!aborted) promptsSent++;
    const result = aborted
      ? Promise.resolve({ status: "cancelled" })
      : new Promise<{ status: string }>((resolve) => {
          signal.addEventListener("abort", () => resolve({ status: "cancelled" }), { once: true });
        });
    return { promptStarted, result, events: (async function* () { await result; })() };
  },
} as unknown as AcpRuntime;
const executor = new AgentRunExecutor(state, {
  maxConcurrent: 1,
  launcher: (request) => request.turnIntent.kind === "resume"
    ? Promise.resolve({ status: AgentRunStatus.Completed, resultText: "continued", error: null })
    : createAcpLauncher({ runtimeFactory: () => runtime })(request),
});
const launch = () => executor.launch({
  harness: AgentRunHarness.Codex, task: "first task", cwd: dir, model: "test-model", effort: null,
});
try {
  const startup = launch();
  await selecting;
  assert.ok(state.agentRunById(startup.id)?.childSessionId);
  assert.ok(state.agentRunById(startup.id)?.acpxRecordId);
  const cancellation = executor.cancel(startup.id);
  holdSelection = false;
  releaseSelection();
  const cancelledBeforeSubmission = await cancellation;
  assert.equal(cancelledBeforeSubmission.status, AgentRunStatus.Cancelled);
  assert.equal(promptsSent, 0);
  assert.equal(deriveParentAgentStateWithEnvironment([cancelledBeforeSubmission]).runs[0].canResume, false,
    "startup cancellation with session ids but no submitted prompt must not be resumable");
  assert.throws(() => executor.resume(startup.id, "continue"), /no confirmed prompt submission/);
  assert.equal(state.listAgentRuns().length, 1, "refusal creates no successor");

  const original = launch();
  const queued = launch();
  await executor.cancel(queued.id);
  assert.throws(() => executor.resume(queued.id, "continue"), /no child session identity/);
  const deadline = Date.now() + 5_000;
  while (promptsSent < 1) {
    assert.ok(Date.now() < deadline, "second prompt is submitted before cancellation");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const cancelled = await executor.cancel(original.id);
  assert.equal(cancelled.status, AgentRunStatus.Cancelled);
  assert.equal(promptsSent, 1);
  assert.equal(deriveParentAgentStateWithEnvironment([cancelled]).runs[0].canResume, true);
  const reopened = new State(join(dir, "state.db"));
  try {
    assert.equal(deriveParentAgentStateWithEnvironment([reopened.agentRunById(original.id)!]).runs[0].canResume, true,
      "submission evidence survives reopening the database");
  } finally { reopened.close(); }

  const resumed = executor.resume(original.id, "continue with the revised task");
  assert.equal(resumed.resumeOfRunId, original.id);
  assert.equal(resumed.retryOfRunId, null);
  assert.equal(resumed.task, "continue with the revised task");
  for (const key of ["childSessionId", "acpxRecordId", "harness", "model", "effort", "cwd", "depth", "timeoutSeconds"] as const) {
    assert.equal(resumed[key], cancelled[key], key);
  }
  assert.equal((await executor.wait(resumed.id, 5_000)).status, AgentRunStatus.Completed);
  assert.deepEqual(state.agentRunById(original.id), cancelled);
  assert.throws(() => executor.resume(original.id, "branch"), /already been resumed/);
  assert.throws(() => executor.retry(original.id), /not retryable/);
  process.stdout.write("ok - startup cancellation refuses resume; submitted cancelled prompts retain continuation\n");
} finally {
  await executor.stop();
  state.close();
  if (previousHome === undefined) delete process.env.OO_HOME;
  else process.env.OO_HOME = previousHome;
  rmSync(dir, { recursive: true, force: true });
}
