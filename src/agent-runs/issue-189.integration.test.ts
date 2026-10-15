import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRunHarness, AgentRunStatus, type AgentRunFinalStatus, type AgentRunLaunchRequest } from "@owner-operator/core";
import { State } from "../state/state";
import { AgentRunExecutor } from "./executor";
import { deriveParentAgentStateWithEnvironment } from "./agent-state-projection";

const dir = mkdtempSync(join(tmpdir(), "oo-issue-189-"));
const previousHome = process.env.OO_HOME;
process.env.OO_HOME = dir;
const state = new State(join(dir, "state.db"));
const requests: AgentRunLaunchRequest[] = [];
const executor = new AgentRunExecutor(state, {
  launcher: async (request) => {
    requests.push(request);
    request.onActivity({
      childSessionId: request.turnIntent.kind === "fresh" ? `new-${request.run.id}` : request.turnIntent.childSessionId,
      acpxRecordId: request.run.acpxRecordId ?? request.run.id,
      promptSubmitted: true,
    });
    return { status: AgentRunStatus.Completed, resultText: "continued", error: null };
  },
});

const terminal = (status: AgentRunFinalStatus, child = true, submitted = child) => {
  const original = state.createAgentRun({
    harness: AgentRunHarness.Codex, task: `original ${status}`, cwd: dir,
    depth: 1, timeoutSeconds: 60,
    ...(child ? { childSessionId: `child-${status}`, acpxRecordId: `record-${status}` } : {}),
  });
  state.claimNextPendingAgentRun(1);
  if (submitted) state.recordAgentRunActivity(original.id, { promptSubmitted: true });
  const finished = state.finishAgentRun(original.id, { status, resultTail: null, error: status })!;
  return finished;
};

try {
  for (const status of [AgentRunStatus.Failed, AgentRunStatus.Cancelled,
    AgentRunStatus.Interrupted, AgentRunStatus.Lost] as AgentRunFinalStatus[]) {
    const original = terminal(status);
    assert.equal(deriveParentAgentStateWithEnvironment([original]).runs[0]?.canResume, true);
    const successor = executor.resume(original.id, `new instructions for ${status}`);
    assert.equal(successor.resumeOfRunId, original.id);
    assert.equal(successor.childSessionId, original.childSessionId);
    assert.equal(successor.acpxRecordId, original.acpxRecordId);
    assert.equal(successor.cwd, original.cwd);
    assert.deepEqual(requests.at(-1)?.turnIntent, {
      kind: "resume", childSessionId: original.childSessionId, acpxRecordId: original.acpxRecordId,
    });
    assert.equal((await executor.wait(successor.id, 5_000)).status, AgentRunStatus.Completed);
    assert.deepEqual(state.agentRunById(original.id), original, "terminal history is unchanged");
    assert.throws(() => executor.resume(original.id, "branch"), /already been resumed/);
  }

  const retriedFirst = terminal(AgentRunStatus.Failed);
  const retrySuccessor = executor.retry(retriedFirst.id);
  assert.equal((await executor.wait(retrySuccessor.id, 5_000)).status, AgentRunStatus.Completed);
  assert.throws(() => executor.resume(retriedFirst.id, "branch from old turn"),
    new RegExp(`already been retried by ${retrySuccessor.id}`));
  assert.equal(deriveParentAgentStateWithEnvironment(state.listAgentRuns()).runs
    .find(({ id }) => id === retriedFirst.id)?.canResume, false);
  const afterRetry = executor.resume(retrySuccessor.id, "continue current conversation");
  assert.equal(afterRetry.resumeOfRunId, retrySuccessor.id);
  assert.equal((await executor.wait(afterRetry.id, 5_000)).status, AgentRunStatus.Completed);

  const resumedFirst = terminal(AgentRunStatus.Failed);
  const resumeSuccessor = executor.resume(resumedFirst.id, "corrected scope");
  assert.equal((await executor.wait(resumeSuccessor.id, 5_000)).status, AgentRunStatus.Completed);
  assert.throws(() => executor.retry(resumedFirst.id),
    new RegExp(`already been resumed by ${resumeSuccessor.id}`));
  assert.equal(deriveParentAgentStateWithEnvironment(state.listAgentRuns()).runs
    .find(({ id }) => id === resumedFirst.id)?.canRetry, false);

  const startup = terminal(AgentRunStatus.Failed, false);
  assert.equal(deriveParentAgentStateWithEnvironment([startup]).runs[0]?.canResume, false);
  const freshRetry = executor.retry(startup.id);
  assert.equal(freshRetry.retryOfRunId, startup.id);
  assert.deepEqual(requests.at(-1)?.turnIntent, { kind: "fresh" }, "explicit retry starts fresh when no record exists");
  assert.equal((await executor.wait(freshRetry.id, 5_000)).status, AgentRunStatus.Completed);

  const recoverable = terminal(AgentRunStatus.Failed, false);
  const sessions = join(dir, "agent-runs", "sessions");
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, `${recoverable.id}.json`), JSON.stringify({
    schema: "acpx.session.v1", acpx_record_id: recoverable.id,
    cwd: dir, acp_session_id: "recovered-acp", agent_session_id: "recovered-native",
  }));
  const recoveredRetry = executor.retry(recoverable.id);
  assert.equal(recoveredRetry.childSessionId, "recovered-native");
  assert.deepEqual(requests.at(-1)?.turnIntent, {
    kind: "retry", childSessionId: "recovered-native", acpxRecordId: recoverable.id,
  }, "an existing record keeps its conversation");
  assert.equal((await executor.wait(recoveredRetry.id, 5_000)).status, AgentRunStatus.Completed);

  const recoverableFollowUp = terminal(AgentRunStatus.Failed, false, false);
  writeFileSync(join(sessions, `${recoverableFollowUp.id}.json`), JSON.stringify({
    schema: "acpx.session.v1", acpx_record_id: recoverableFollowUp.id,
    cwd: dir, acp_session_id: "follow-up-acp", agent_session_id: "follow-up-native",
  }));
  assert.equal(deriveParentAgentStateWithEnvironment(state.listAgentRuns())
    .runs.find((run) => run.id === recoverableFollowUp.id)?.canResume, true);
  const recoveredFollowUp = executor.resume(recoverableFollowUp.id, "corrected scope");
  assert.equal(recoveredFollowUp.childSessionId, "follow-up-native");
  assert.deepEqual(requests.at(-1)?.turnIntent, {
    kind: "resume", childSessionId: "follow-up-native", acpxRecordId: recoverableFollowUp.id,
  });
  assert.equal((await executor.wait(recoveredFollowUp.id, 5_000)).status, AgentRunStatus.Completed);

  const recoveredCancellation = terminal(AgentRunStatus.Cancelled, false, false);
  writeFileSync(join(sessions, `${recoveredCancellation.id}.json`), JSON.stringify({
    schema: "acpx.session.v1", acpx_record_id: recoveredCancellation.id,
    cwd: dir, acp_session_id: "cancelled-acp", agent_session_id: "cancelled-native",
  }));
  const cancellationFollowUp = executor.resume(recoveredCancellation.id, "continue after cancellation");
  assert.deepEqual(requests.at(-1)?.turnIntent, {
    kind: "resume", childSessionId: "cancelled-native", acpxRecordId: recoveredCancellation.id,
  });
  assert.equal((await executor.wait(cancellationFollowUp.id, 5_000)).status, AgentRunStatus.Completed);

  const conflicted = terminal(AgentRunStatus.Failed, false);
  writeFileSync(join(sessions, `${conflicted.id}.json`), JSON.stringify({
    schema: "acpx.session.v1", acpx_record_id: conflicted.id,
    cwd: dir, acp_session_id: "recovered-acp", agent_session_id: "recovered-native",
  }));
  const active = state.createAgentRun({
    harness: AgentRunHarness.Codex, task: "active same conversation", cwd: dir,
    depth: 1, timeoutSeconds: 60, childSessionId: "recovered-native",
  });
  assert.equal(deriveParentAgentStateWithEnvironment(state.listAgentRuns())
    .runs.find((run) => run.id === conflicted.id)?.canRetry, false);
  assert.throws(() => executor.retry(conflicted.id), /already has active run/);
  state.finishAgentRun(active.id, { status: AgentRunStatus.Cancelled, resultTail: null, error: "not started" });

  const unsafe = terminal(AgentRunStatus.Failed, false);
  writeFileSync(join(sessions, `${unsafe.id}.json`), "{bad json");
  assert.equal(deriveParentAgentStateWithEnvironment([unsafe]).runs[0]?.canRetry, false);
  assert.throws(() => executor.retry(unsafe.id), /cannot be recovered; no fresh session was started/);
  assert.equal(state.listAgentRuns().filter((run) => run.retryOfRunId === unsafe.id).length, 0);
  process.stdout.write("ok - terminal continuation, startup retry, record recovery, and refusal of silent replacement\n");
} finally {
  await executor.stop();
  state.close();
  if (previousHome === undefined) delete process.env.OO_HOME;
  else process.env.OO_HOME = previousHome;
  rmSync(dir, { recursive: true, force: true });
}
