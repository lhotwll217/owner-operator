import assert from "node:assert";
import { agentRunFixture as run } from "../../../test/fixtures/agent-run";
import {
  AGENT_RUN_RESUME_TASK_ERROR,
  AgentRunStatus,
  agentRunRetryError,
  agentRunResumeError,
  agentRunTurnIntent,
  validateAgentRunResumeTask,
} from "./agent-runs";

const completed = run("completed", AgentRunStatus.Completed, {
  childSessionId: "native-child",
  acpxRecordId: "acpx-record",
});

const failedForRetry = run("failed-for-retry", AgentRunStatus.Failed, {
  childSessionId: "retry-child",
});
assert.equal(
  agentRunRetryError(failedForRetry, { existingRetryRunId: null, activeRunId: null }),
  null,
  "an unsuccessful run with a durable child identity can be retried",
);
assert.match(
  agentRunRetryError(failedForRetry, { existingRetryRunId: "exact-retry", activeRunId: null }) ?? "",
  /already been retried by exact-retry/,
);
assert.match(
  agentRunRetryError(failedForRetry, { existingRetryRunId: null, activeRunId: "other-active" }) ?? "",
  /already has active run other-active/,
);
assert.match(
  agentRunRetryError(
    { ...failedForRetry, childSessionId: null },
    { existingRetryRunId: null, activeRunId: null },
  ) ?? "",
  /no child session identity/,
);

assert.equal(
  agentRunResumeError(completed, { existingResumeRunId: null, activeRunId: null }),
  null,
  "a completed latest run with both identities can be resumed",
);
assert.match(
  agentRunResumeError(completed, { existingResumeRunId: "next", activeRunId: null }) ?? "",
  /already been resumed by next/,
);
assert.match(
  agentRunResumeError(completed, { existingResumeRunId: null, activeRunId: "active" }) ?? "",
  /already has active run active/,
);
assert.match(
  agentRunResumeError(
    { ...completed, acpxRecordId: null },
    { existingResumeRunId: null, activeRunId: null },
  ) ?? "",
  /no acpx session-record identity/,
);

assert.equal(validateAgentRunResumeTask("  follow up  "), "  follow up  ");
for (const invalid of [undefined, null, "", "   "]) {
  assert.throws(
    () => validateAgentRunResumeTask(invalid),
    (error: unknown) => error instanceof Error && error.message === AGENT_RUN_RESUME_TASK_ERROR,
  );
}

assert.deepEqual(agentRunTurnIntent(run("fresh", AgentRunStatus.Running), undefined, undefined), { kind: "fresh" });
const failed = run("failed", AgentRunStatus.Failed, {
  childSessionId: "retry-child",
  acpxRecordId: "retry-acpx",
});
const retry = run("retry", AgentRunStatus.Running, {
  childSessionId: "retry-child",
  acpxRecordId: "retry-acpx",
  retryOfRunId: failed.id,
});
assert.deepEqual(agentRunTurnIntent(retry, failed, undefined), {
  kind: "retry",
  childSessionId: "retry-child",
  acpxRecordId: "retry-acpx",
});
const resumed = run("resumed", AgentRunStatus.Running, {
  childSessionId: completed.childSessionId,
  acpxRecordId: completed.acpxRecordId,
  resumeOfRunId: completed.id,
});
assert.deepEqual(agentRunTurnIntent(resumed, undefined, completed), {
  kind: "resume",
  childSessionId: "native-child",
  acpxRecordId: "acpx-record",
});
assert.throws(
  () => agentRunTurnIntent(resumed, undefined, undefined),
  /references missing resume run completed/,
  "a missing resumed run cannot silently downgrade to a fresh turn",
);
assert.throws(
  () => agentRunTurnIntent({ ...resumed, childSessionId: "different-child" }, undefined, completed),
  /child identity mismatch with resumed run/,
);
assert.throws(
  () => agentRunTurnIntent({ ...resumed, retryOfRunId: failed.id }, failed, completed),
  /cannot set both retryOfRunId and resumeOfRunId/,
);

process.stdout.write("ok — delegated-run retry/resume rules and turn intent are explicit\n");
