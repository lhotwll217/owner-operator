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

const cancelled = { ...completed, id: "cancelled", status: AgentRunStatus.Cancelled, promptSubmitted: true };
assert.equal(
  agentRunResumeError(cancelled, { existingResumeRunId: null, activeRunId: null }),
  null,
  "a cancelled run with both identities can resume its child conversation",
);
assert.deepEqual(agentRunTurnIntent({
  ...cancelled, id: "continued", status: AgentRunStatus.Pending, resumeOfRunId: cancelled.id,
}, undefined, cancelled), {
  kind: "resume", childSessionId: "native-child", acpxRecordId: "acpx-record",
});
for (const status of [AgentRunStatus.Pending, AgentRunStatus.Running]) {
  assert.match(agentRunResumeError({ ...completed, status }, {
    existingResumeRunId: null, activeRunId: null,
  }) ?? "", /cannot be resumed while/);
}
for (const status of [AgentRunStatus.Failed, AgentRunStatus.Interrupted, AgentRunStatus.Lost]) {
  assert.equal(agentRunResumeError({ ...completed, status, promptSubmitted: true }, {
    existingResumeRunId: null, activeRunId: null,
  }), null, `${status} with a saved conversation accepts new instructions`);
  assert.equal(agentRunResumeError({ ...completed, status, promptSubmitted: false }, {
    existingResumeRunId: null, activeRunId: null,
  }), null, `${status} can reload a saved session before prompt acknowledgement`);
}
const failedRetryBeforePrompt = { ...completed, status: AgentRunStatus.Failed,
  promptSubmitted: false, retryOfRunId: "earlier-failed" };
assert.equal(agentRunResumeError(failedRetryBeforePrompt, {
  existingResumeRunId: null, activeRunId: null,
}), null, "a failed retry inherits the earlier conversation before its own prompt");
assert.match(agentRunRetryError(cancelled, {
  existingRetryRunId: null, activeRunId: null,
}) ?? "", /not retryable/);
const unsubmitted = { ...cancelled, promptSubmitted: false };
assert.equal(agentRunResumeError(unsubmitted, { existingResumeRunId: null, activeRunId: null }), null);
assert.deepEqual(agentRunTurnIntent({ ...unsubmitted, id: "continued-before-prompt", resumeOfRunId: cancelled.id },
  undefined, unsubmitted), { kind: "resume", childSessionId: "native-child", acpxRecordId: "acpx-record" });
const unsubmittedSuccessor = { ...unsubmitted, id: "successor", resumeOfRunId: cancelled.id };
assert.equal(agentRunResumeError(unsubmittedSuccessor, { existingResumeRunId: null, activeRunId: null }), null,
  "a cancelled resume successor retains the submitted conversation before its own prompt");
assert.deepEqual(agentRunTurnIntent({ ...unsubmittedSuccessor, id: "next", resumeOfRunId: unsubmittedSuccessor.id },
  undefined, unsubmittedSuccessor), { kind: "resume", childSessionId: "native-child", acpxRecordId: "acpx-record" });
for (const identity of [{ childSessionId: null }, { acpxRecordId: null }]) {
  assert.match(agentRunResumeError({ ...cancelled, ...identity }, {
    existingResumeRunId: null, activeRunId: null,
  }) ?? "", /no .*identity to resume/);
}

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
  agentRunRetryError(failedForRetry, {
    existingRetryRunId: null, existingResumeRunId: "corrected-successor", activeRunId: null,
  }) ?? "", /already been resumed by corrected-successor/,
);
assert.match(
  agentRunRetryError(failedForRetry, { existingRetryRunId: null, activeRunId: "other-active" }) ?? "",
  /already has active run other-active/,
);
assert.equal(
  agentRunRetryError(
    { ...failedForRetry, childSessionId: null },
    { existingRetryRunId: null, activeRunId: null },
  ), null, "startup failure can explicitly retry in a fresh conversation",
);
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
  agentRunResumeError({ ...failedForRetry, acpxRecordId: "saved-record" }, {
    existingResumeRunId: null, existingRetryRunId: "retried-successor", activeRunId: null,
  }) ?? "", /already been retried by retried-successor/,
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
