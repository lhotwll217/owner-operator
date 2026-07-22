import assert from "node:assert";
import { AgentRunHarness, AgentRunStatus, type AgentRun, type GatewayApi } from "@owner-operator/core";
import { manageAgentRun, manageAgentRunTool } from "./manage-agent-run";

assert.match(manageAgentRunTool.description, /not for monitoring/i, "the tool reserves status and wait for explicit owner requests");

const run: AgentRun = {
  id: "run-1",
  harness: AgentRunHarness.ClaudeCode,
  task: "audit dependencies",
  cwd: "/tmp/example-repo",
  parentThreadId: "parent-1",
  model: null,
  effort: null,
  effortApplied: false,
  depth: 1,
  status: AgentRunStatus.Running,
  createdAt: "2026-07-17T10:00:00.000Z",
  startedAt: "2026-07-17T10:00:01.000Z",
  finishedAt: null,
  activity: "reading package.json",
  lastActivityAt: "2026-07-17T10:00:05.000Z",
  childSessionId: "child-1",
  acpxRecordId: "acpx-1",
  resultTail: null,
  error: null,
  resumeOfRunId: null,
  timeoutSeconds: 3_600,
};

const calls: string[] = [];
const backend = {
  async agentRun(id: string) { calls.push(`status:${id}`); return run; },
  async cancelAgentRun(id: string) { calls.push(`cancel:${id}`); return { ...run, status: AgentRunStatus.Cancelled }; },
  async resumeAgentRun(id: string) {
    calls.push(`resume:${id}`);
    return { ...run, id: "run-2", resumeOfRunId: id, status: AgentRunStatus.Pending };
  },
  async waitAgentRun(id: string, timeoutSeconds: number) {
    calls.push(`wait:${id}:${timeoutSeconds}`);
    return { ...run, status: AgentRunStatus.Completed, resultTail: "done" };
  },
} as Pick<GatewayApi, "agentRun" | "cancelAgentRun" | "resumeAgentRun" | "waitAgentRun">;

assert.equal((await manageAgentRun(backend, { action: "status", id: "run-1" })).status, AgentRunStatus.Running);
assert.equal((await manageAgentRun(backend, { action: "cancel", id: "run-1" })).status, AgentRunStatus.Cancelled);
const resumed = await manageAgentRun(backend, { action: "resume", id: "run-1" });
assert.equal(resumed.id, "run-2");
assert.equal(resumed.resumeOfRunId, "run-1", "resume returns a new run continuing the same identity");
const waited = await manageAgentRun(backend, { action: "wait", id: "run-1", waitSeconds: 120 });
assert.equal(waited.status, AgentRunStatus.Completed);

assert.deepEqual(calls, ["status:run-1", "cancel:run-1", "resume:run-1", "wait:run-1:120"]);
await manageAgentRun(backend, { action: "wait", id: "run-1" });
assert.equal(calls.at(-1), "wait:run-1:60", "wait defaults to 60s");

process.stdout.write("ok — manage_agent_run routes status/cancel/resume/wait to the backend\n");
