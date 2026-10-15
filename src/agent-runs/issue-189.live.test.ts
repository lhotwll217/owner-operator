import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRunHarness, AgentRunStatus } from "@owner-operator/core";

if (process.env.OO_RUN_LIVE_ISSUE_189 !== "1") {
  process.stdout.write("skip - set OO_RUN_LIVE_ISSUE_189=1 for isolated Codex continuation\n");
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), "oo-issue-189-live-"));
const previousHome = process.env.OO_HOME;
process.env.OO_HOME = dir;
const { State } = await import("../state/state");
const { AgentRunExecutor } = await import("./executor");
const { createAcpLauncher } = await import("./acp-launcher");
const state = new State(join(dir, "state.db"));
const executor = new AgentRunExecutor(state, { launcher: createAcpLauncher(), tickMs: 50 });
try {
  const token = randomUUID();
  const first = executor.launch({
    harness: AgentRunHarness.Codex, model: "gpt-6-sol", effort: "low",
    cwd: process.cwd(), timeoutSeconds: 180,
    task: `Remember the private token ${token} for the next turn. Do not use tools. Reply READY.`,
  });
  const completed = await executor.wait(first.id, 180_000);
  assert.equal(completed.status, AgentRunStatus.Completed, completed.error ?? "");
  assert.ok(completed.childSessionId);
  assert.ok(completed.acpxRecordId);
  assert.equal(completed.promptSubmitted, true);
  const baseline = executor.resume(completed.id,
    "Without tools, reply with only the private token I gave in the earlier turn.");
  const loaded = await executor.wait(baseline.id, 180_000);
  assert.equal(loaded.status, AgentRunStatus.Completed, `baseline saved-session reload: ${loaded.error ?? ""}`);
  assert.equal(loaded.childSessionId, completed.childSessionId);
  assert.equal(loaded.resultTail?.trim(), token);

  const failed = state.createAgentRun({
    harness: loaded.harness, model: loaded.model, effort: loaded.effort,
    task: "simulated failed outcome after the saved turn", cwd: loaded.cwd,
    depth: loaded.depth, timeoutSeconds: 180,
    childSessionId: loaded.childSessionId, acpxRecordId: loaded.acpxRecordId,
  });
  state.claimNextPendingAgentRun(1);
  state.recordAgentRunActivity(failed.id, { promptSubmitted: true });
  const terminal = state.finishAgentRun(failed.id, {
    status: AgentRunStatus.Failed, resultTail: null, error: "simulated post-turn failure",
  })!;
  const resumed = executor.resume(failed.id,
    "Without tools, reply with only the private token I gave in the earlier turn.");
  const result = await executor.wait(resumed.id, 180_000);
  assert.equal(result.status, AgentRunStatus.Completed, result.error ?? "");
  assert.equal(result.childSessionId, completed.childSessionId);
  assert.equal(result.acpxRecordId, completed.acpxRecordId);
  assert.equal(result.resumeOfRunId, failed.id);
  assert.equal(result.resultTail?.trim(), token);
  assert.deepEqual(state.agentRunById(failed.id), terminal);
  process.stdout.write("ok - real Codex ACP loaded the exact saved child after a failed terminal row\n");
} finally {
  await executor.stop();
  state.close();
  if (previousHome === undefined) delete process.env.OO_HOME;
  else process.env.OO_HOME = previousHome;
  rmSync(dir, { recursive: true, force: true });
}
