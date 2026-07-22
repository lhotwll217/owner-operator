import {
  AgentRunHarness,
  AgentRunStatus,
  type AgentRun,
} from "../../packages/core/src/agent-runs";

/** Sanitized delegated-run fixture shared across core, adapter, and Gateway tests. */
export function agentRunFixture(
  id: string,
  status: AgentRunStatus,
  overrides: Partial<AgentRun> = {},
): AgentRun {
  return {
    id,
    harness: AgentRunHarness.ClaudeCode,
    task: `task ${id}`,
    cwd: "/tmp/repo",
    parentThreadId: "parent-90",
    model: null,
    effort: null,
    effortApplied: false,
    depth: 1,
    status,
    createdAt: "2026-07-21T12:00:00.000Z",
    startedAt: status === AgentRunStatus.Pending ? null : "2026-07-21T12:01:00.000Z",
    finishedAt: [AgentRunStatus.Pending, AgentRunStatus.Running].includes(status)
      ? null
      : "2026-07-21T12:05:00.000Z",
    activity: null,
    lastActivityAt: null,
    childSessionId: null,
    acpxRecordId: null,
    resultTail: null,
    error: null,
    resumeOfRunId: null,
    timeoutSeconds: 3_600,
    ...overrides,
  };
}
