import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRunHarness, AgentRunStatus, type AgentRun } from "@owner-operator/core";
import { agentRunFixture as run } from "../../test/fixtures/agent-run";
import { continuationsOf, deriveParentAgentStateWithEnvironment } from "./continuation";

const previousHome = process.env.OO_HOME;
const home = mkdtempSync(join(tmpdir(), "oo-continuation-home-"));
const root = mkdtempSync(join(tmpdir(), "oo-continuation-cwd-"));
process.env.OO_HOME = home;
try {
  const now = "2026-07-21T12:10:00.000Z";
  const refused = (reason: string) => ({ kind: "refused", reason });
  const retry = (target: AgentRun, ...others: AgentRun[]) => continuationsOf([target, ...others]).retry(target);
  const resume = (target: AgentRun, ...others: AgentRun[]) => continuationsOf([target, ...others]).resume(target);

  const file = join(root, "not-a-directory");
  writeFileSync(file, "fixture");
  const rows = [
    run("existing-cwd", AgentRunStatus.Completed, {
      cwd: root,
      childSessionId: "existing-child",
      acpxRecordId: "existing-acpx",
    }),
    run("missing-cwd", AgentRunStatus.Completed, {
      cwd: join(root, "missing"),
      childSessionId: "missing-child",
      acpxRecordId: "missing-acpx",
    }),
    run("file-cwd", AgentRunStatus.Completed, {
      cwd: file,
      childSessionId: "file-child",
      acpxRecordId: "file-acpx",
    }),
  ];
  const view = deriveParentAgentStateWithEnvironment(rows, { now });
  assert.equal(view.runs.find(({ id }) => id === "existing-cwd")?.canResume, true);
  assert.equal(view.runs.find(({ id }) => id === "missing-cwd")?.canResume, false);
  assert.equal(view.runs.find(({ id }) => id === "file-cwd")?.canResume, false);
  const environment = continuationsOf(rows);
  assert.equal(environment.resume(rows[0]!).kind, "eligible");
  assert.deepEqual(environment.resume(rows[1]!),
    refused(`resume working directory no longer exists: ${join(root, "missing")}`));
  assert.deepEqual(environment.resume(rows[2]!), refused(`resume working directory is not a directory: ${file}`));

  const completed = run("completed", AgentRunStatus.Completed, {
    cwd: root,
    childSessionId: "native-child",
    acpxRecordId: "acpx-record",
  });
  const cancelled = { ...completed, id: "cancelled", status: AgentRunStatus.Cancelled, promptSubmitted: true };
  assert.deepEqual(resume(cancelled), {
    kind: "eligible",
    successor: {
      harness: AgentRunHarness.ClaudeCode,
      cwd: root,
      parentThreadId: "parent-90",
      model: null,
      effort: null,
      depth: 1,
      timeoutSeconds: 3_600,
      resumeOfRunId: "cancelled",
      childSessionId: "native-child",
      acpxRecordId: "acpx-record",
    },
  }, "a cancelled run with both identities can resume its child conversation");
  for (const status of [AgentRunStatus.Pending, AgentRunStatus.Running]) {
    assert.deepEqual(resume({ ...completed, status }), refused(`agent run completed cannot be resumed while ${status}`));
  }
  for (const status of [AgentRunStatus.Failed, AgentRunStatus.Interrupted, AgentRunStatus.Lost]) {
    assert.equal(resume({ ...completed, status, promptSubmitted: true }).kind, "eligible",
      `${status} with a saved conversation accepts new instructions`);
    assert.equal(resume({ ...completed, status, promptSubmitted: false }).kind, "eligible",
      `${status} can reload a saved session before prompt acknowledgement`);
  }
  assert.equal(resume({ ...completed, status: AgentRunStatus.Failed, promptSubmitted: false,
    retryOfRunId: "earlier-failed" }).kind, "eligible",
  "a failed retry inherits the earlier conversation before its own prompt");
  assert.deepEqual(retry(cancelled), refused("agent run cancelled is not retryable from status cancelled"));
  const unsubmitted = { ...cancelled, promptSubmitted: false };
  assert.equal(resume(unsubmitted).kind, "eligible");
  assert.equal(resume({ ...unsubmitted, id: "successor", resumeOfRunId: cancelled.id }).kind, "eligible",
    "a cancelled resume successor retains the submitted conversation before its own prompt");
  assert.deepEqual(resume({ ...cancelled, childSessionId: null, acpxRecordId: null }),
    refused("agent run cancelled has no child session identity to resume"));
  assert.deepEqual(resume({ ...cancelled, childSessionId: null }),
    refused("saved ACP session record acpx-record is missing; no fresh session was started"));
  assert.deepEqual(resume({ ...cancelled, acpxRecordId: null }),
    refused("agent run cancelled has no acpx session-record identity to resume"));

  const failedForRetry = run("failed-for-retry", AgentRunStatus.Failed, {
    childSessionId: "retry-child",
  });
  const retrySuccessor = {
    harness: AgentRunHarness.ClaudeCode,
    cwd: "/tmp/repo",
    parentThreadId: "parent-90",
    model: null,
    effort: null,
    depth: 1,
    timeoutSeconds: 3_600,
    task: "task failed-for-retry",
    retryOfRunId: "failed-for-retry",
    completionRunIds: [],
    childSessionId: "retry-child",
    acpxRecordId: null,
  };
  assert.deepEqual(retry(failedForRetry), { kind: "eligible", successor: retrySuccessor },
    "an unsuccessful run with a durable child identity can be retried");
  const exactRetry = run("exact-retry", AgentRunStatus.Failed, {
    childSessionId: "retry-child",
    retryOfRunId: failedForRetry.id,
  });
  assert.deepEqual(retry(failedForRetry, exactRetry),
    refused("agent run failed-for-retry has already been retried by exact-retry"));
  const pendingRetry = { ...exactRetry, status: AgentRunStatus.Pending };
  assert.deepEqual(retry(failedForRetry, pendingRetry), { kind: "in-flight", successor: pendingRetry });
  assert.deepEqual(retry(failedForRetry, run("corrected-successor", AgentRunStatus.Completed, {
    childSessionId: "retry-child",
    resumeOfRunId: failedForRetry.id,
  })), refused("agent run failed-for-retry has already been resumed by corrected-successor"));
  assert.deepEqual(retry(failedForRetry, run("other-active", AgentRunStatus.Running, {
    childSessionId: "retry-child",
  })), refused("child session retry-child already has active run other-active"));
  assert.deepEqual(retry({ ...failedForRetry, childSessionId: null }),
    { kind: "eligible", successor: { ...retrySuccessor, childSessionId: null } },
    "startup failure can explicitly retry in a fresh conversation");

  assert.equal(resume(completed).kind, "eligible", "a completed latest run with both identities can be resumed");
  assert.deepEqual(resume(completed, run("next", AgentRunStatus.Completed, {
    childSessionId: "native-child",
    acpxRecordId: "acpx-record",
    resumeOfRunId: completed.id,
  })), refused("agent run completed has already been resumed by next"));
  assert.deepEqual(resume({ ...failedForRetry, acpxRecordId: "saved-record" }, run("retried-successor",
    AgentRunStatus.Completed, { childSessionId: "retry-child", retryOfRunId: failedForRetry.id })),
  refused("agent run failed-for-retry has already been retried by retried-successor"));
  assert.deepEqual(resume(completed, run("active", AgentRunStatus.Running, { childSessionId: "native-child" })),
    refused("child session native-child already has active run active"));

  const fleet = deriveParentAgentStateWithEnvironment([
    run("completed-new", AgentRunStatus.Completed, {
      cwd: root,
      childSessionId: "completed-child",
      acpxRecordId: "completed-acpx",
      finishedAt: "2026-07-21T12:09:00.000Z",
    }),
    run("running", AgentRunStatus.Running, {
      harness: AgentRunHarness.Codex,
      childSessionId: "codex-child",
    }),
    run("failed", AgentRunStatus.Failed, {
      childSessionId: "failed-child",
      finishedAt: "2026-07-21T12:08:00.000Z",
    }),
    run("lost-no-child", AgentRunStatus.Lost, {
      finishedAt: "2026-07-21T12:07:00.000Z",
    }),
  ], { now });
  const controls = (id: string) => {
    const found = fleet.runs.find((candidate) => candidate.id === id)!;
    return { canRetry: found.canRetry, canResume: found.canResume };
  };
  assert.deepEqual(controls("running"), { canRetry: false, canResume: false });
  assert.equal(controls("failed").canRetry, true, "failed child identity is retryable");
  assert.equal(controls("lost-no-child").canRetry, true,
    "an explicit retry can start fresh after a startup loss with no saved child");
  assert.equal(controls("completed-new").canResume, true, "the latest completed session can take a follow-up");

  const interrupted = run("interrupted-run", AgentRunStatus.Interrupted, { childSessionId: "retried-child" });
  const runningRetry = run("retry", AgentRunStatus.Running, {
    childSessionId: "retried-child",
    retryOfRunId: "interrupted-run",
  });
  assert.deepEqual(retry(interrupted, runningRetry), { kind: "in-flight", successor: runningRetry });
  assert.equal(
    deriveParentAgentStateWithEnvironment([interrupted, runningRetry], { now })
      .runs.find(({ id }) => id === "interrupted-run")?.canRetry,
    false,
    "a retried interrupted run cannot be retried again",
  );

  const resumedCompleted = deriveParentAgentStateWithEnvironment([
    run("completed-run", AgentRunStatus.Completed, {
      cwd: root,
      childSessionId: "resumed-child",
      acpxRecordId: "resumed-acpx",
    }),
    run("resumed-run", AgentRunStatus.Completed, {
      cwd: root,
      childSessionId: "resumed-child",
      acpxRecordId: "resumed-acpx",
      resumeOfRunId: "completed-run",
    }),
  ], { now });
  assert.equal(
    resumedCompleted.runs.find(({ id }) => id === "completed-run")?.canResume,
    false,
    "a completed run that has been resumed cannot branch the child conversation",
  );
  assert.equal(
    resumedCompleted.runs.find(({ id }) => id === "resumed-run")?.canResume,
    true,
    "the latest completed run can take the next follow-up",
  );

  assert.deepEqual(
    resume(run("completed-without-acpx", AgentRunStatus.Completed, { cwd: root, childSessionId: "child-only" })),
    refused("agent run completed-without-acpx has no acpx session-record identity to resume"),
    "resume control requires both child and acpx identities",
  );

  assert.deepEqual(
    retry(
      run("failed-before-other-turn", AgentRunStatus.Failed, { childSessionId: "busy-child" }),
      run("other-active-turn", AgentRunStatus.Running, {
        childSessionId: "busy-child",
        resumeOfRunId: "some-completed-run",
      }),
    ),
    refused("child session busy-child already has active run other-active-turn"),
    "retry is unavailable while any other run is active on the child",
  );

  assert.deepEqual(
    retry(run("unknown-harness", AgentRunStatus.Failed, {
      harness: "future-harness" as AgentRun["harness"],
      childSessionId: "future-child",
    })),
    refused("harness future-harness does not support loading an existing session"),
    "unknown harness capabilities fail closed",
  );
} finally {
  if (previousHome === undefined) delete process.env.OO_HOME;
  else process.env.OO_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
}

process.stdout.write("ok — retry and resume verdicts follow run lineage, identity, and a live workspace\n");
