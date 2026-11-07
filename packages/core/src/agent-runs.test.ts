import assert from "node:assert";
import { agentRunFixture as run } from "../../../test/fixtures/agent-run";
import {
  AGENT_RUN_RESUME_TASK_ERROR,
  AgentRunStatus,
  agentRunTurnIntent,
  validateAgentRunResumeTask,
} from "./agent-runs";

const completed = run("completed", AgentRunStatus.Completed, {
  childSessionId: "native-child",
  acpxRecordId: "acpx-record",
});

const cancelled = { ...completed, id: "cancelled", status: AgentRunStatus.Cancelled, promptSubmitted: true };
assert.deepEqual(agentRunTurnIntent({
  ...cancelled, id: "continued", status: AgentRunStatus.Pending, resumeOfRunId: cancelled.id,
}, undefined, cancelled), {
  kind: "resume", childSessionId: "native-child", acpxRecordId: "acpx-record",
});
const unsubmitted = { ...cancelled, promptSubmitted: false };
assert.deepEqual(agentRunTurnIntent({ ...unsubmitted, id: "continued-before-prompt", resumeOfRunId: cancelled.id },
  undefined, unsubmitted), { kind: "resume", childSessionId: "native-child", acpxRecordId: "acpx-record" });
const unsubmittedSuccessor = { ...unsubmitted, id: "successor", resumeOfRunId: cancelled.id };
assert.deepEqual(agentRunTurnIntent({ ...unsubmittedSuccessor, id: "next", resumeOfRunId: unsubmittedSuccessor.id },
  undefined, unsubmittedSuccessor), { kind: "resume", childSessionId: "native-child", acpxRecordId: "acpx-record" });

const failedForRetry = run("failed-for-retry", AgentRunStatus.Failed, {
  childSessionId: "retry-child",
});
assert.deepEqual(agentRunTurnIntent({
  ...failedForRetry, id: "startup-retry", status: AgentRunStatus.Pending,
  childSessionId: null, retryOfRunId: failedForRetry.id,
}, { ...failedForRetry, childSessionId: null }, undefined), { kind: "fresh" });
assert.deepEqual(agentRunTurnIntent({
  ...failedForRetry, id: "recovered-retry", status: AgentRunStatus.Pending,
  childSessionId: "recovered-child", acpxRecordId: failedForRetry.id,
  retryOfRunId: failedForRetry.id,
}, { ...failedForRetry, childSessionId: null }, undefined), {
  kind: "retry", childSessionId: "recovered-child", acpxRecordId: failedForRetry.id,
});

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

process.stdout.write("ok — delegated-run turn intent and resume task validation are explicit\n");
