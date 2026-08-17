import assert from "node:assert";
import {
  AGENT_RUN_CONTINUATION_TASK_ERROR,
  AgentRunHarness,
  AgentRunStatus,
  type AgentRun,
  type GatewayApi,
} from "@owner-operator/core";
import { manageAgentRun, manageAgentRunTool } from "./manage-agent-run";

assert.match(manageAgentRunTool.description, /not for monitoring/i, "the tool reserves status for explicit owner requests");
assert.ok(!manageAgentRunTool.description.includes("wait"), "no blocking wait affordance: completions arrive as events");
assert.match(manageAgentRunTool.description, /continue.*new follow-up task/i);

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
  async continueAgentRun(id: string, task: string) {
    calls.push(`continue:${id}:${task}`);
    return { ...run, id: "run-3", task, resumeOfRunId: id, status: AgentRunStatus.Pending };
  },
} as Pick<GatewayApi, "agentRun" | "cancelAgentRun" | "resumeAgentRun" | "continueAgentRun">;

assert.equal((await manageAgentRun(backend, { action: "status", id: "run-1" })).status, AgentRunStatus.Running);
assert.equal((await manageAgentRun(backend, { action: "cancel", id: "run-1" })).status, AgentRunStatus.Cancelled);
const resumed = await manageAgentRun(backend, { action: "resume", id: "run-1" });
assert.equal(resumed.id, "run-2");
assert.equal(resumed.resumeOfRunId, "run-1", "resume returns a new run continuing the same identity");
const continued = await manageAgentRun(backend, {
  action: "continue",
  id: "run-1",
  task: "explain the audit finding",
});
assert.equal(continued.id, "run-3");
assert.equal(continued.task, "explain the audit finding");
await assert.rejects(
  () => manageAgentRun(backend, { action: "continue", id: "run-1", task: "  " }),
  (error: unknown) => error instanceof Error && error.message === AGENT_RUN_CONTINUATION_TASK_ERROR,
);

assert.deepEqual(calls, [
  "status:run-1",
  "cancel:run-1",
  "resume:run-1",
  "continue:run-1:explain the audit finding",
]);

process.stdout.write("ok — manage_agent_run distinguishes recovery resume from completed-session follow-up\n");
