import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRunHarness, AgentRunStatus, isTerminalAgentRunStatus, type AgentRun } from "@owner-operator/core";
import { repoRoot } from "../shared/repo-root";

if (process.env.OO_RUN_LIVE_CANCEL_RESUME !== "1") {
  process.stdout.write("skip - set OO_RUN_LIVE_CANCEL_RESUME=1, OO_LIVE_RESUME_HARNESS and OO_LIVE_RESUME_MODEL\n");
  process.exit(0);
}
const harness = process.env.OO_LIVE_RESUME_HARNESS as AgentRunHarness;
const model = process.env.OO_LIVE_RESUME_MODEL;
assert.ok(Object.values(AgentRunHarness).includes(harness));
assert.ok(model, "choose an explicit model for the paid live test");
const root = mkdtempSync(join(tmpdir(), "oo-cancel-resume-live-"));
const priorHome = process.env.OO_HOME;
process.env.OO_HOME = join(root, "oo");
for (const key of ["OO_FROM_SESSION", "CODEX_THREAD_ID"]) delete process.env[key];
const { startDaemon } = await import("../daemon/runtime");
const daemon = await startDaemon({
  port: 0, watch: false, enableEnrichment: false,
  monitor: { scan: async () => [], intervalMs: 60_000 },
  scheduler: { tickMs: 60_000 },
});
const cli = async (args: string[]): Promise<AgentRun> => {
  const child = spawn(join(repoRoot, "oo"), ["runs", ...args, "--json"], {
    cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(code, 0, stderr);
  return JSON.parse(stdout) as AgentRun;
};
const waitFor = async (id: string, ready: (run: AgentRun) => boolean): Promise<AgentRun> => {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const run = daemon.state.agentRunById(id)!;
    if (ready(run)) return run;
    assert.ok(!isTerminalAgentRunStatus(run.status), JSON.stringify(run));
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${id}`);
};
try {
  const nonce = `memory-${randomUUID()}`;
  const task = `Remember this private conversation token: ${nonce}. Do not write it to any file or tool. `
    + "Say READY, then run the shell command sleep 120, then say WAIT_FINISHED. Complete this directly without any subagents.";
  const original = await cli(["delegate", "--harness", harness, "--model", model,
    ...(process.env.OO_LIVE_RESUME_EFFORT ? ["--effort", process.env.OO_LIVE_RESUME_EFFORT] : []), "--no-wait", task]);
  const running = await waitFor(original.id, (run) => run.status === AgentRunStatus.Running
    && daemon.state.agentRunEvents(run.id).some(({ record }) => record.type === "tool_call"
      && /sleep 120/.test(JSON.stringify(record))));
  assert.ok(running.childSessionId);
  const cancelled = await cli(["cancel", original.id]);
  assert.equal(cancelled.status, AgentRunStatus.Cancelled);
  const resumed = await cli(["resume", original.id,
    "The wait was cancelled intentionally. Without tools, reply with only the private conversation token from my earlier message."]);
  const finished = await waitFor(resumed.id, (run) => isTerminalAgentRunStatus(run.status));
  assert.equal(finished.status, AgentRunStatus.Completed, finished.error ?? "");
  assert.equal(finished.childSessionId, running.childSessionId);
  assert.equal(finished.acpxRecordId, running.acpxRecordId);
  assert.equal(finished.resumeOfRunId, original.id);
  assert.equal(finished.resultTail?.trim(), nonce);
  assert.deepEqual(daemon.state.agentRunById(original.id), cancelled);
  assert.ok(!daemon.state.agentRunEvents(finished.id).some(({ record }) => record.type === "tool_call"),
    "token recall must use the saved conversation without tools");
  process.stdout.write(JSON.stringify({ harness, model, ooHome: process.env.OO_HOME, port: daemon.port,
    originalRunId: original.id, resumedRunId: finished.id, childSessionId: finished.childSessionId,
    acpxRecordId: finished.acpxRecordId, cancelledDuring: "sleep 120", status: finished.status,
    expectedToken: nonce, result: finished.resultTail?.trim() }) + "\n");
} finally {
  await daemon.close();
  const leaseDir = join(root, "oo", "agent-runs", "process-leases");
  const leases = existsSync(leaseDir) ? readdirSync(leaseDir) : [];
  assert.equal(leases.length, 0, "isolated child process leases must be released");
  if (priorHome === undefined) delete process.env.OO_HOME;
  else process.env.OO_HOME = priorHome;
  rmSync(root, { recursive: true, force: true });
}
