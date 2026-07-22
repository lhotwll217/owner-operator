// Integration: the delegated-run executor over a real State — queue-under-cap, lifecycle
// mapping from launcher outcomes, cancel/timeout/stop semantics, restart interruption,
// the lost sweeper, resume lineage, and bounded wait.
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentRunHarness,
  AgentRunStatus,
  DomainEventKind,
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
      request.onActivity({
        activity: "child started",
        childSessionId: `child-${request.run.id}`,
        acpxRecordId: `acpx-${request.run.id}`,
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
  assert.equal(first.model, "sonnet", "Claude delegated work uses the configured non-1M default");
  assert.equal(first.effort, null, "Claude records no effort when its adapter has no configured support");
  const second = executor.launch({
    harness: AgentRunHarness.Codex,
    task: "audit dependencies",
    cwd: dir,
    parentThreadId: "parent-1",
  });
  assert.equal(second.model, "gpt-5.6-sol", "Codex delegated work uses the configured default");
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
    effort: "minimal",
  });
  assert.equal(third.model, "caller-selected-model", "a caller-pinned model always wins");
  assert.equal(third.effort, "minimal", "a caller-pinned effort always wins");
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
  assert.throws(() => restarted.resume(orphan.id), /child session/, "resume without identity is rejected");
  const resumable = state.agentRunById(sixth.id)!;
  assert.ok(resumable.childSessionId, "interrupted run kept its child identity");
  const resumedRun = restarted.resume(sixth.id);
  assert.equal(resumedRun.resumeOfRunId, sixth.id);
  assert.equal(resumedRun.childSessionId, resumable.childSessionId, "resume reuses the child session identity");
  await waitFor(() => launches.length === 7, "resumed run to start");
  assert.equal(
    launches[6].request.resumeSessionId,
    resumable.childSessionId,
    "the launcher is asked to resume the same child session",
  );
  launches[6].finish({ status: AgentRunStatus.Completed, resultText: "resumed fine", error: null });
  await waitFor(() => state.agentRunById(resumedRun.id)?.status === AgentRunStatus.Completed, "resumed run completion");
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
  await startupExecutor.stop();
  startupState.close();

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
