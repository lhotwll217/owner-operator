import assert from "node:assert";
import { agentRunFixture as run } from "../../../test/fixtures/agent-run";
import {
  AGENT_RUN_CONTINUATION_TASK_ERROR,
  AgentRunStatus,
  agentRunContinuationError,
  agentRunSessionIntent,
  validateAgentRunContinuationTask,
} from "./agent-runs";

const completed = run("completed", AgentRunStatus.Completed, {
  childSessionId: "native-child",
  acpxRecordId: "acpx-record",
});

assert.equal(
  agentRunContinuationError(completed, { successorRunId: null, activeRunId: null }),
  null,
  "a completed latest turn with both identities is domain-eligible",
);
assert.match(
  agentRunContinuationError(completed, { successorRunId: "next", activeRunId: null }) ?? "",
  /already been continued by next/,
);
assert.match(
  agentRunContinuationError(completed, { successorRunId: null, activeRunId: "active" }) ?? "",
  /already has active run active/,
);
assert.match(
  agentRunContinuationError(
    { ...completed, acpxRecordId: null },
    { successorRunId: null, activeRunId: null },
  ) ?? "",
  /no acpx session-record identity/,
);

assert.equal(validateAgentRunContinuationTask("  follow up  "), "  follow up  ");
for (const invalid of [undefined, null, "", "   "]) {
  assert.throws(
    () => validateAgentRunContinuationTask(invalid),
    (error: unknown) => error instanceof Error && error.message === AGENT_RUN_CONTINUATION_TASK_ERROR,
  );
}

assert.deepEqual(agentRunSessionIntent(run("fresh", AgentRunStatus.Running), undefined), { kind: "fresh" });
const failed = run("failed", AgentRunStatus.Failed, { childSessionId: "recovery-child" });
const recovery = run("recovery", AgentRunStatus.Running, {
  childSessionId: "recovery-child",
  resumeOfRunId: failed.id,
});
assert.deepEqual(agentRunSessionIntent(recovery, failed), {
  kind: "resume",
  childSessionId: "recovery-child",
});
const continuation = run("continuation", AgentRunStatus.Running, {
  childSessionId: completed.childSessionId,
  acpxRecordId: completed.acpxRecordId,
  resumeOfRunId: completed.id,
});
assert.deepEqual(agentRunSessionIntent(continuation, completed), {
  kind: "continue",
  childSessionId: "native-child",
  acpxRecordId: "acpx-record",
});
assert.throws(
  () => agentRunSessionIntent(continuation, undefined),
  /references missing source completed/,
  "a missing source cannot silently downgrade continuation to recovery",
);
assert.throws(
  () => agentRunSessionIntent({ ...continuation, childSessionId: "different-child" }, completed),
  /child identity mismatch/,
);

process.stdout.write("ok — delegated-run continuation rules and launch intent are explicit\n");
