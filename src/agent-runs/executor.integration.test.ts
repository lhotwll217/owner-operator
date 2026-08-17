// Integration: the delegated-run executor over a real State — queue-under-cap, lifecycle
// mapping from launcher outcomes, cancel/timeout/stop semantics, restart interruption,
// the lost sweeper, retry/resume relationships, and bounded wait.
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  AGENT_RUN_RESUME_TASK_ERROR,
  AgentRunHarness,
  AgentRunStatus,
  DomainEventKind,
  approveDelegatedBaseline,
  type AgentRunLaunchRequest,
  type AgentRunLaunchResult,
  type DomainEvent,
} from "@owner-operator/core";
import { InMemoryEventBus } from "../state/event-bus";
import { State } from "../state/state";
import { AgentRunExecutor } from "./executor";

const dir = mkdtempSync(join(tmpdir(), "oo-agent-runs-"));
const previousOoHome = process.env.OO_HOME;
process.env.OO_HOME = dir;
approveDelegatedBaseline(AgentRunHarness.ClaudeCode, { model: "test-claude", effort: null }, dir);
approveDelegatedBaseline(AgentRunHarness.Codex, { model: "test-codex", effort: "high" }, dir);

const waitFor = async (predicate: () => boolean, label: string, timeoutMs = 5_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const events: DomainEvent[] = [];
const bus = new InMemoryEventBus();
bus.subscribe((event) => { events.push(event); });

let closeState: (() => void) | undefined;
try {
  const state = new State(join(dir, "state.db"), { bus });
  closeState = () => state.close();

  // A controllable fake launcher: each launch parks until the test resolves it or the
  // executor aborts it. Activity/identity are reported the way the acpx launcher would.
  const launches: Array<{
    request: AgentRunLaunchRequest;
    finish: (result: AgentRunLaunchResult) => void;
  }> = [];
  const launcher = (request: AgentRunLaunchRequest): Promise<AgentRunLaunchResult> =>
    new Promise((resolve, reject) => {
      const intendedChild = request.turnIntent.kind === "fresh"
        ? `child-${request.run.id}`
        : request.turnIntent.childSessionId;
      request.onActivity({
        activity: "child started",
        childSessionId: intendedChild,
        acpxRecordId: request.run.acpxRecordId ?? `acpx-${request.run.id}`,
      });
      const abort = (): void => reject(request.signal.reason ?? new Error("aborted"));
      if (request.signal.aborted) return abort();
      request.signal.addEventListener("abort", abort, { once: true });
      launches.push({ request, finish: resolve });
    });

  const executor = new AgentRunExecutor(state, {
    launcher,
    maxConcurrent: 1,
    tickMs: 20,
    lostGraceMs: 60_000,
    logger: () => undefined,
  });
  executor.start();

  // --- launch: background default — returns the durable row immediately ------------------
  const first = executor.launch({
    harness: AgentRunHarness.ClaudeCode,
    task: "research the flaky test",
    cwd: dir,
  });
  assert.equal(first.status, AgentRunStatus.Pending, "launch returns before execution starts");
  assert.equal(first.depth, 1, "operator launches are depth 1");
  assert.equal(first.model, "test-claude", "Claude delegated work uses the approved baseline");
  assert.equal(first.effort, null, "a nullable approved effort reaches the durable row");
  const second = executor.launch({
    harness: AgentRunHarness.Codex,
    task: "audit dependencies",
    cwd: dir,
    parentThreadId: "parent-1",
  });
  assert.equal(second.model, "test-codex", "Codex delegated work uses the approved baseline");
  assert.equal(second.effort, "high", "Codex effort is resolved into the durable pending row before launch");
  assert.equal(second.effortApplied, false, "intent starts distinguishably unapplied");

  // --- queue under cap: one runs, the other waits as pending ------------------------------
  await waitFor(() => launches.length === 1, "first run to start");
  assert.equal(state.agentRunById(first.id)?.status, AgentRunStatus.Running);
  assert.equal(state.agentRunById(second.id)?.status, AgentRunStatus.Pending, "cap 1 queues the second run");
  assert.equal(state.agentRunById(first.id)?.activity, "child started", "explicit activity lands in the ledger");
  assert.equal(state.agentRunById(first.id)?.childSessionId, `child-${first.id}`, "child identity persisted at spawn");

  // --- protocol result finalizes the run; the queue advances ------------------------------
  launches[0].finish({
    status: AgentRunStatus.Completed,
    resultText: "found the race in retry logic",
    error: null,
  });
  await waitFor(() => state.agentRunById(first.id)?.status === AgentRunStatus.Completed, "first run completion");
  assert.equal(state.agentRunById(first.id)?.resultTail, "found the race in retry logic");
  await waitFor(() => launches.length === 2, "queued run to start after a slot frees");
  assert.equal(state.agentRunById(second.id)?.status, AgentRunStatus.Running);

  // --- wait: bounded block until terminal --------------------------------------------------
  const waited = executor.wait(second.id, 5_000);
  launches[1].finish({ status: AgentRunStatus.Failed, resultText: "partial notes", error: "turn failed: tool error" });
  const secondFinal = await waited;
  assert.equal(secondFinal.status, AgentRunStatus.Failed, "failed launcher outcome lands as failed");
  assert.equal(secondFinal.resultTail, "partial notes", "failed runs keep partial output");
  assert.equal(secondFinal.error, "turn failed: tool error");

  // --- cancel: running run aborts and records cancelled ------------------------------------
  const third = executor.launch({
    harness: AgentRunHarness.ClaudeCode,
    task: "third",
    cwd: dir,
    model: "caller-selected-model",
    effort: "max",
  });
  assert.equal(third.model, "caller-selected-model", "a caller-pinned model always wins");
  assert.equal(third.effort, "max", "a caller-pinned advertised frontier effort always wins");
  await waitFor(() => launches.length === 3, "third run to start");
  const cancelledThird = await executor.cancel(third.id);
  assert.equal(cancelledThird.status, AgentRunStatus.Cancelled, "cancel resolves with the finalized row");
  assert.equal(state.agentRunById(third.id)?.status, AgentRunStatus.Cancelled, "cancel lands");

  // --- cancel a queued run without it ever starting ----------------------------------------
  // The fourth run occupies the single slot (maxConcurrent 1), so the fifth stays pending.
  executor.launch({ harness: AgentRunHarness.ClaudeCode, task: "fourth", cwd: dir });
  const fifth = executor.launch({ harness: AgentRunHarness.ClaudeCode, task: "fifth", cwd: dir });
  await waitFor(() => launches.length === 4, "fourth run to start");
  const cancelledFifth = await executor.cancel(fifth.id);
  assert.equal(cancelledFifth.status, AgentRunStatus.Cancelled, "pending cancel is immediate");
  assert.equal(state.agentRunById(fifth.id)?.status, AgentRunStatus.Cancelled);

  // --- timeout: OO owns the deadline; late results never resurrect the row ----------------
  const timed = executor.launch({ harness: AgentRunHarness.ClaudeCode, task: "slow", cwd: dir, timeoutSeconds: 1 });
  launches[3].finish({ status: AgentRunStatus.Completed, resultText: "fourth done", error: null });
  await waitFor(() => launches.length === 5, "timed run to start");
  await waitFor(() => state.agentRunById(timed.id)?.status === AgentRunStatus.Failed, "timeout marks failed", 10_000);
  assert.match(state.agentRunById(timed.id)?.error ?? "", /timed out/, "timeout is explained in the run row");

  // --- validation guards -------------------------------------------------------------------
  assert.throws(() => executor.launch({ harness: "gemini" as AgentRunHarness, task: "x", cwd: dir }), /harness/);
  assert.throws(() => executor.launch({ harness: AgentRunHarness.Codex, task: "  ", cwd: dir }), /task/);
  assert.throws(() => executor.launch({ harness: AgentRunHarness.Codex, task: "x", cwd: "relative/path" }), /absolute/);
  assert.throws(
    () => executor.launch({ harness: AgentRunHarness.Codex, task: "x", cwd: dir, effort: "extreme" as never }),
    /effort/,
  );


  // --- stop: active runs are interrupted, not lost -----------------------------------------
  const sixth = executor.launch({ harness: AgentRunHarness.ClaudeCode, task: "sixth", cwd: dir });
  await waitFor(() => launches.length === 6, "sixth run to start");
  await executor.stop();
  assert.equal(state.agentRunById(sixth.id)?.status, AgentRunStatus.Interrupted, "stop interrupts active runs");

  // --- restart: a fresh executor marks orphaned running rows interrupted -------------------
  const orphanState = state;
  const orphan = orphanState.createAgentRun({
    harness: AgentRunHarness.ClaudeCode, task: "orphan", cwd: dir, depth: 1, timeoutSeconds: 60,
  });
  orphanState.claimNextPendingAgentRun(1);
  const restarted = new AgentRunExecutor(orphanState, { launcher, tickMs: 20, logger: () => undefined });
  restarted.start();
  assert.equal(orphanState.agentRunById(orphan.id)?.status, AgentRunStatus.Interrupted, "restart reconciles running rows");

  // --- resume: same child identity, new run row --------------------------------------------
  assert.throws(() => restarted.retry(orphan.id), /child session/, "retry without identity is rejected");
  const retryable = state.agentRunById(sixth.id)!;
  assert.ok(retryable.childSessionId, "interrupted run kept its child identity");
  const retriedRun = restarted.retry(sixth.id);
  assert.equal(retriedRun.retryOfRunId, sixth.id);
  assert.equal(retriedRun.childSessionId, retryable.childSessionId, "retry reuses the child session identity");
  await waitFor(() => launches.length === 7, "retried run to start");
  assert.equal(
    launches[6].request.turnIntent.kind === "retry"
      ? launches[6].request.turnIntent.childSessionId
      : null,
    retryable.childSessionId,
    "the launcher is asked to retry the same child session",
  );
  launches[6].finish({ status: AgentRunStatus.Completed, resultText: "resumed fine", error: null });
  await waitFor(() => state.agentRunById(retriedRun.id)?.status === AgentRunStatus.Completed, "retried run completion");
  assert.throws(() => restarted.retry(sixth.id), /already been retried/);

  // --- resume: a completed run gets a new task in a new row under the exact identities ---
  const completedRun = state.agentRunById(retriedRun.id)!;
  const resumedRun = restarted.resume(retriedRun.id, "answer the follow-up question");
  assert.equal(resumedRun.task, "answer the follow-up question", "resume requires and records a new task");
  assert.equal(resumedRun.resumeOfRunId, retriedRun.id, "resume records the exact completed run");
  assert.equal(resumedRun.childSessionId, completedRun.childSessionId, "resume reuses the child identity");
  assert.equal(resumedRun.acpxRecordId, completedRun.acpxRecordId, "resume reuses the acpx record identity");
  assert.equal(resumedRun.cwd, completedRun.cwd);
  assert.equal(resumedRun.model, completedRun.model);
  assert.equal(resumedRun.effort, completedRun.effort);
  assert.equal(resumedRun.depth, completedRun.depth);
  assert.equal(resumedRun.timeoutSeconds, completedRun.timeoutSeconds);
  await waitFor(() => launches.length === 8, "resumed run to start");
  assert.deepEqual(launches[7].request.turnIntent, {
    kind: "resume",
    childSessionId: completedRun.childSessionId,
    acpxRecordId: completedRun.acpxRecordId,
  });
  assert.equal(launches[7].request.run.acpxRecordId, completedRun.acpxRecordId);
  launches[7].finish({ status: AgentRunStatus.Completed, resultText: "follow-up answered", error: null });
  await waitFor(() => state.agentRunById(resumedRun.id)?.status === AgentRunStatus.Completed, "resumed run completion");
  assert.equal(state.agentRunById(retriedRun.id)?.resultTail, "resumed fine", "the completed run stays immutable");

  assert.throws(() => restarted.resume(sixth.id, "not completed"), /completed/);
  assert.throws(
    () => restarted.resume(resumedRun.id, "  "),
    (error: unknown) => error instanceof Error && error.message === AGENT_RUN_RESUME_TASK_ERROR,
  );
  assert.throws(() => restarted.resume(retriedRun.id, "reuse completed context"), /already been resumed/);
  const invalidCompletedRun = state.createAgentRun({
    harness: AgentRunHarness.ClaudeCode,
    task: "legacy completed row",
    cwd: dir,
    depth: 1,
    timeoutSeconds: 60,
  });
  state.finishAgentRun(invalidCompletedRun.id, {
    status: AgentRunStatus.Completed,
    resultTail: "done without identity",
    error: null,
  });
  assert.throws(
    () => restarted.resume(invalidCompletedRun.id, "follow up"),
    /no child session identity/,
    "an invalid completed run fails before creating a row",
  );
  const beforeMissingCwd = state.listAgentRuns().length;
  const missingCwdRun = state.createAgentRun({
    harness: AgentRunHarness.ClaudeCode,
    task: "completed run whose workspace was removed",
    cwd: join(dir, "missing-cwd"),
    model: completedRun.model,
    effort: completedRun.effort,
    depth: completedRun.depth,
    timeoutSeconds: completedRun.timeoutSeconds,
    childSessionId: "missing-cwd-child",
    acpxRecordId: "missing-cwd-acpx",
  });
  state.finishAgentRun(missingCwdRun.id, {
    status: AgentRunStatus.Completed,
    resultTail: "done",
    error: null,
  });
  assert.throws(() => restarted.resume(missingCwdRun.id, "follow up"), /working directory no longer exists/);
  assert.equal(state.listAgentRuns().length, beforeMissingCwd + 1, "missing cwd fails before a resume row is created");
  await restarted.stop();

  // --- lost sweeper: stale running row with no live turn ------------------------------------
  const ghost = state.createAgentRun({
    harness: AgentRunHarness.ClaudeCode, task: "ghost", cwd: dir, depth: 1, timeoutSeconds: 60,
  });
  state.claimNextPendingAgentRun(1);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const sweeper = new AgentRunExecutor(state, {
    launcher, tickMs: 10, lostGraceMs: 20, logger: () => undefined,
  });
  // Deliberately NOT marking startup interruption here — sweep only.
  sweeper.sweepLostRuns();
  assert.equal(state.agentRunById(ghost.id)?.status, AgentRunStatus.Lost, "stale running row without a live turn is lost");
  await sweeper.stop();

  // --- events: every transition published on the bus ---------------------------------------
  await new Promise((resolve) => setImmediate(resolve));
  const runEvents = events.filter((event) => event.kind === DomainEventKind.AgentRunChanged);
  assert.ok(
    runEvents.some((event) => event.kind === DomainEventKind.AgentRunChanged && event.runId === first.id && event.status === AgentRunStatus.Completed),
    "completion events reach the bus",
  );

  // --- immediate startup failure: pending presentation is replaced by terminal truth -------
  const startupState = new State(join(dir, "startup-failure.db"), { bus: new InMemoryEventBus() });
  const startupExecutor = new AgentRunExecutor(startupState, {
    launcher: async () => { throw new Error("ACP handshake incompatible"); },
    tickMs: 20,
    logger: () => undefined,
  });
  startupExecutor.start();
  const startupFailure = startupExecutor.launch({
    harness: AgentRunHarness.Codex,
    task: "fail before child identity",
    cwd: dir,
    parentThreadId: "startup-parent",
  });
  assert.equal(startupFailure.status, AgentRunStatus.Pending, "launch retains its nonblocking snapshot");
  await waitFor(
    () => startupState.agentRunById(startupFailure.id)?.status === AgentRunStatus.Failed,
    "startup rejection to become terminal",
  );
  const failedStartup = startupState.agentRunById(startupFailure.id)!;
  assert.equal(failedStartup.activity, null, "startup failure does not preserve invented pending activity");
  assert.ok(failedStartup.finishedAt, "startup failure has an actionable terminal timestamp");
  assert.equal(failedStartup.error, "ACP handshake incompatible");

  const staleCompletedRun = startupState.createAgentRun({
    harness: AgentRunHarness.Codex,
    task: "completed before its ACP record became stale",
    cwd: dir,
    model: "test-codex",
    effort: "high",
    depth: 1,
    timeoutSeconds: 60,
    childSessionId: "stale-child",
    acpxRecordId: "stale-acpx",
  });
  startupState.finishAgentRun(staleCompletedRun.id, {
    status: AgentRunStatus.Completed,
    resultTail: "completed result",
    error: null,
  });
  const staleResume = startupExecutor.resume(staleCompletedRun.id, "new paid follow-up");
  await waitFor(
    () => startupState.agentRunById(staleResume.id)?.status === AgentRunStatus.Failed,
    "stale resume failure to become terminal",
  );
  assert.equal(startupState.agentRunById(staleResume.id)?.resumeOfRunId, staleCompletedRun.id);
  assert.equal(startupState.agentRunById(staleResume.id)?.error, "ACP handshake incompatible");
  assert.equal(startupState.agentRunById(staleCompletedRun.id)?.status, AgentRunStatus.Completed);
  assert.equal(startupState.agentRunById(staleCompletedRun.id)?.resultTail, "completed result");
  await startupExecutor.stop();
  startupState.close();

  // --- corrupt resume relationship fails closed before launcher dispatch -----------------
  const corruptPath = join(dir, "missing-resumed-run.db");
  const corruptState = new State(corruptPath, { bus: new InMemoryEventBus() });
  const corruptCompletedRun = corruptState.createAgentRun({
    harness: AgentRunHarness.ClaudeCode,
    task: "completed run",
    cwd: dir,
    depth: 1,
    timeoutSeconds: 60,
    childSessionId: "corrupt-child",
    acpxRecordId: "corrupt-acpx",
  });
  corruptState.finishAgentRun(corruptCompletedRun.id, {
    status: AgentRunStatus.Completed,
    resultTail: "completed result",
    error: null,
  });
  const dormantExecutor = new AgentRunExecutor(corruptState, {
    launcher,
    maxConcurrent: 0,
    logger: () => undefined,
  });
  const corruptResume = dormantExecutor.resume(corruptCompletedRun.id, "follow up");
  const corruptDb = new DatabaseSync(corruptPath);
  corruptDb.exec("PRAGMA foreign_keys = OFF");
  corruptDb.prepare("DELETE FROM agent_runs WHERE id = ?").run(corruptCompletedRun.id);
  corruptDb.close();
  let corruptLaunchCalls = 0;
  const corruptExecutor = new AgentRunExecutor(corruptState, {
    launcher: async () => {
      corruptLaunchCalls += 1;
      throw new Error("must not launch");
    },
    tickMs: 20,
    logger: () => undefined,
  });
  corruptExecutor.start();
  await waitFor(
    () => corruptState.agentRunById(corruptResume.id)?.status === AgentRunStatus.Failed,
    "missing resumed run to fail",
  );
  assert.match(corruptState.agentRunById(corruptResume.id)?.error ?? "", /references missing resume run/);
  assert.equal(corruptLaunchCalls, 0, "missing resume relationship cannot downgrade into a launcher call");
  await corruptExecutor.stop();
  await dormantExecutor.stop();
  corruptState.close();

  // --- depth cap: delegating from a thread that is itself a delegated child is rejected -----
  // Isolated so the never-started executor's pump can't disturb the positional launches above.
  const depthState = new State(join(dir, "depth.db"), { bus: new InMemoryEventBus() });
  const depthExecutor = new AgentRunExecutor(depthState, { launcher, logger: () => undefined });
  depthState.createAgentRun({
    harness: AgentRunHarness.ClaudeCode, task: "a delegated child", cwd: dir, depth: 1,
    timeoutSeconds: 60, childSessionId: "delegated-child-session",
  });
  assert.throws(
    () => depthExecutor.launch({
      harness: AgentRunHarness.Codex, task: "grandchild", cwd: dir, parentThreadId: "delegated-child-session",
    }),
    /depth/,
    "a run whose parent is itself a delegated child exceeds the depth cap",
  );
  depthState.close();

  process.stdout.write("ok — delegated-run executor lifecycle over real state\n");
} finally {
  closeState?.();
  if (previousOoHome === undefined) delete process.env.OO_HOME;
  else process.env.OO_HOME = previousOoHome;
  rmSync(dir, { recursive: true, force: true });
}
