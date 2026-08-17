import assert from "node:assert";
import {
  AGENT_RUN_RESUME_TASK_ERROR,
  AgentRunHarness,
  AgentRunStatus,
  type AgentRun,
  type GatewayApi,
} from "@owner-operator/core";
import { manageAgentRun, manageAgentRunTool } from "./manage-agent-run";

assert.match(manageAgentRunTool.description, /not for monitoring/i, "the tool reserves status for explicit owner requests");
assert.ok(!manageAgentRunTool.description.includes("wait"), "no blocking wait affordance: completions arrive as events");
assert.match(manageAgentRunTool.description, /retry.*same task/i);
assert.match(manageAgentRunTool.description, /resume.*new follow-up task/i);
assert.ok(!manageAgentRunTool.description.includes("continue"));

const run: AgentRun = {
  id: "run-1",
  harness: AgentRunHarness.ClaudeCode,
  task: "audit dependencies",
  cwd: "/tmp/example-repo",
  parentThreadId: "parent-1",
  model: null,
  effort: null,
  effortApplied: false,
  harnessIdentity: { observed: false },
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
    retryOfRunId: null,
    resumeOfRunId: null,
  timeoutSeconds: 3_600,
};

const calls: string[] = [];
const backend = {
  async agentRun(id: string) { calls.push(`status:${id}`); return run; },
  async cancelAgentRun(id: string) { calls.push(`cancel:${id}`); return { ...run, status: AgentRunStatus.Cancelled }; },
  async retryAgentRun(id: string) {
    calls.push(`retry:${id}`);
    return { ...run, id: "run-2", retryOfRunId: id, status: AgentRunStatus.Pending };
  },
  async resumeAgentRun(id: string, task: string) {
    calls.push(`resume:${id}:${task}`);
    return { ...run, id: "run-3", task, resumeOfRunId: id, status: AgentRunStatus.Pending };
  },
} as Pick<GatewayApi, "agentRun" | "cancelAgentRun" | "retryAgentRun" | "resumeAgentRun">;

assert.equal((await manageAgentRun(backend, { action: "status", id: "run-1" })).status, AgentRunStatus.Running);
assert.equal((await manageAgentRun(backend, { action: "cancel", id: "run-1" })).status, AgentRunStatus.Cancelled);
const retried = await manageAgentRun(backend, { action: "retry", id: "run-1" });
assert.equal(retried.id, "run-2");
assert.equal(retried.retryOfRunId, "run-1", "retry records the exact run being retried");
const resumed = await manageAgentRun(backend, {
  action: "resume",
  id: "run-1",
  task: "explain the audit finding",
});
assert.equal(resumed.id, "run-3");
assert.equal(resumed.task, "explain the audit finding");
await assert.rejects(
  () => manageAgentRun(backend, { action: "resume", id: "run-1", task: "  " }),
  (error: unknown) => error instanceof Error && error.message === AGENT_RUN_RESUME_TASK_ERROR,
);

assert.deepEqual(calls, [
  "status:run-1",
  "cancel:run-1",
  "retry:run-1",
  "resume:run-1:explain the audit finding",
]);

process.stdout.write("ok — manage_agent_run exposes retry and task-required resume\n");
