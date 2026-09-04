// End-to-end fixture for issues #69 and #131: drive a delegated run through the whole daemon HTTP
// surface — launch, observe live state while the parent stays responsive, restart and
// reconcile to a durable interrupted state, resume to the same child identity, receive the
// durable result, and cancel a run. It also proves that the active root tool cwd, not the daemon
// checkout, becomes the default child workspace and remains immutable across retry/resume.
// The provider process itself is a controllable fake launcher;
// the opt-in acp-launcher.live.test.ts drives the same path through real Claude/acpx. The
// crash-vs-graceful reconciliation on start() is also covered in executor.integration.test.ts.
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AGENT_RUN_RESUME_TASK_ERROR,
  type AgentRun,
  AgentRunHarness,
  AgentRunStatus,
  GatewayEventKind,
  approveDelegatedBaseline,
  type AgentRunLaunchRequest,
  type AgentRunLaunchResult,
  type GatewayEvent,
} from "@owner-operator/core";
import { delegateAgentTool } from "../agent/tools/delegate-agent";
import type { AgentRunLauncher } from "../agent-runs/executor";
import { connectGateway } from "../gateway/client";
import { fakeScanRow, tempOoHome, waitFor } from "../gateway/test/helpers";
import { startDaemon } from "./runtime";

const { dir: ooHome, cleanup } = tempOoHome("oo-agent-runs-e2e");
approveDelegatedBaseline(AgentRunHarness.ClaudeCode, { model: "test-claude", effort: null }, ooHome);
approveDelegatedBaseline(AgentRunHarness.Codex, { model: "test-codex", effort: "high" }, ooHome);

const invocationCwd = process.cwd();
const fixtureRoot = join(ooHome, "delegation-isolation");
const daemonCheckoutPath = join(fixtureRoot, "daemon-checkout");
const selectedWorktreePath = join(fixtureRoot, "selected-worktree");
const explicitChildPath = join(fixtureRoot, "explicit-child");
mkdirSync(daemonCheckoutPath, { recursive: true });
const daemonCheckout = realpathSync(daemonCheckoutPath);
execFileSync("git", ["init", "-q", daemonCheckout]);
execFileSync("git", ["-C", daemonCheckout, "config", "user.email", "delegation@example.invalid"]);
execFileSync("git", ["-C", daemonCheckout, "config", "user.name", "Delegation Fixture"]);
writeFileSync(join(daemonCheckout, "canary.txt"), "daemon checkout\n");
execFileSync("git", ["-C", daemonCheckout, "add", "canary.txt"]);
execFileSync("git", ["-C", daemonCheckout, "commit", "-qm", "fixture"]);
execFileSync("git", ["-C", daemonCheckout, "worktree", "add", "-qb", "ticket-06", selectedWorktreePath]);
const selectedWorktree = realpathSync(selectedWorktreePath);
writeFileSync(join(selectedWorktree, "canary.txt"), "selected worktree\n");
mkdirSync(explicitChildPath, { recursive: true });
const explicitChildCwd = realpathSync(explicitChildPath);
writeFileSync(join(explicitChildCwd, "canary.txt"), "explicit child\n");

const gitStatus = (cwd: string): string => execFileSync(
  "git",
  ["-C", cwd, "status", "--short", "--untracked-files=all"],
  { encoding: "utf8" },
);
const initialCheckoutStatus = gitStatus(daemonCheckout);
const initialSelectedStatus = gitStatus(selectedWorktree);
const initialCheckoutCanary = readFileSync(join(daemonCheckout, "canary.txt"), "utf8");
const initialSelectedCanary = readFileSync(join(selectedWorktree, "canary.txt"), "utf8");
process.chdir(daemonCheckout);

interface ExecutionObservation {
  cwd: string;
  canary: string;
  edit: string;
}

const executeHermeticEdit = (cwd: string, edit: string, contents: string): ExecutionObservation => {
  const script = [
    'const { readFileSync, writeFileSync } = require("node:fs");',
    "writeFileSync(process.argv[1], process.argv[2]);",
    'process.stdout.write(JSON.stringify({ cwd: process.cwd(), canary: readFileSync("canary.txt", "utf8") }));',
  ].join("\n");
  const result = JSON.parse(execFileSync(
    process.execPath,
    ["-e", script, edit, contents],
    { cwd, encoding: "utf8" },
  )) as Pick<ExecutionObservation, "cwd" | "canary">;
  return { ...result, edit };
};

// A controllable launcher shared across daemon incarnations: each launch parks on a promise
// the test resolves (or the executor aborts on stop/cancel). It reports the child's ACP
// identity the way the real acpx bridge does.
const parked: Array<{ request: AgentRunLaunchRequest; finish: (r: AgentRunLaunchResult) => void }> = [];
const childExecutions = new Map<string, ExecutionObservation>();
let startupReaps = 0;
const launcher: AgentRunLauncher = (request: AgentRunLaunchRequest): Promise<AgentRunLaunchResult> =>
  new Promise((resolve, reject) => {
    const intendedChild = request.turnIntent.kind === "fresh"
      ? `child-${request.run.task.replace(/\W+/g, "-")}`
      : request.turnIntent.childSessionId;
    request.onActivity({
      activity: "child started",
      childSessionId: intendedChild,
      acpxRecordId: request.run.acpxRecordId ?? `acpx-${request.run.task.replace(/\W+/g, "-")}`,
    });
    childExecutions.set(request.run.id, executeHermeticEdit(
      request.run.cwd,
      `child-edit-${request.run.id}.txt`,
      `${request.run.task}\n`,
    ));
    const abort = (): void => reject(request.signal.reason ?? new Error("aborted"));
    if (request.signal.aborted) return abort();
    request.signal.addEventListener("abort", abort, { once: true });
    parked.push({ request, finish: resolve });
  });
launcher.reapOrphans = async () => { startupReaps += 1; };

const startOnce = () => startDaemon({
  port: 0,
  watch: false,
  enableEnrichment: false,
  monitor: {
    scan: async () => [fakeScanRow({
      id: "operator-thread",
      source: "pi",
      repo: "issue-131",
      app: "Owner Operator",
      topic: "Delegate ticket 02",
    })],
    intervalMs: 60_000,
  },
  scheduler: { tickMs: 60_000 },
  agentRuns: { launcher, tickMs: 20, maxConcurrent: 3, logger: () => undefined },
});

let daemon = await startOnce();
type GatewayConn = NonNullable<Awaited<ReturnType<typeof connectGateway>>>;
const toolContext = {
  cwd: selectedWorktree,
  sessionManager: { getSessionId: () => "operator-thread" },
} as Parameters<typeof delegateAgentTool.execute>[4];
let gateway: GatewayConn | undefined;
let gateway2: GatewayConn | undefined;
try {
  assert.equal(startupReaps, 1, "daemon startup reaps stale delegated process trees before launch");
  assert.equal(initialCheckoutStatus, "", "the checkout running OO starts clean");
  assert.equal(initialSelectedStatus, " M canary.txt\n", "the selected-worktree canary fingerprints its checkout");
  gateway = (await connectGateway())!;
  assert.ok(gateway, "ready daemon is discoverable");
  await waitFor(
    () => daemon.state.listCurrentSessionState().some(({ id }) => id === "operator-thread"),
    1_000,
    "monitored Operator root",
  );
  assert.equal(
    (await gateway.sessionState()).find(({ id }) => id === "operator-thread")?.state,
    "needs-you",
    "the root starts from transcript-derived state",
  );

  const sseEvents: GatewayEvent[] = [];
  const unsubscribe = gateway.subscribe((event) => sseEvents.push(event));

  assert.equal(process.cwd(), daemonCheckout, "the daemon process remains rooted in its install checkout");
  assert.equal(toolContext.cwd, selectedWorktree, "the active root tool context uses the selected worktree");
  assert.notEqual(toolContext.sessionManager.getSessionId(), toolContext.cwd,
    "stable root session identity remains separate from execution cwd");
  const rootExecution = executeHermeticEdit(toolContext.cwd, "root-edit.txt", "root edit\n");
  assert.deepEqual(rootExecution, {
    cwd: selectedWorktree,
    canary: "selected worktree\n",
    edit: "root-edit.txt",
  }, "root execution and edits use the selected worktree");

  // --- omitted cwd: active Operator context supplies workspace and parent lineage ----------
  const launchResult = await delegateAgentTool.execute(
    "delegate-test",
    {
      harness: AgentRunHarness.ClaudeCode,
      task: "research flaky test",
    },
    undefined,
    undefined,
    toolContext,
  );
  const launched = launchResult.details as AgentRun;
  assert.equal(launched.status, AgentRunStatus.Pending, "delegate returns before the child runs");
  assert.equal(launched.depth, 1);
  assert.equal(launched.parentThreadId, "operator-thread", "the Operator tool binds trusted parent lineage");
  assert.equal(launched.cwd, selectedWorktree, "omitted cwd is recorded from the active root tool context");
  assert.notEqual(launched.cwd, process.cwd(), "omitted cwd never falls back to the daemon process cwd");
  await waitFor(
    () => sseEvents.some((event) => event.kind === GatewayEventKind.AgentRunChanged),
    1_000,
    "pending child SSE invalidation",
  );
  assert.equal(
    (await gateway.sessionState()).find(({ id }) => id === "operator-thread")?.state,
    "working",
    "refetching session state after the agent-run invalidation sees the pending transition",
  );

  // The launcher records activity synchronously before parking, so once the child is parked
  // the ledger row is already running — parked.length is the real synchronization point.
  await waitFor(() => parked.length === 1, 3_000, "child to start");
  const running = await gateway.agentRun(launched.id);
  assert.equal(running.status, AgentRunStatus.Running);
  assert.equal(running.activity, "child started", "explicit activity is captured in the ledger");
  assert.equal(running.childSessionId, "child-research-flaky-test", "child identity captured at spawn");
  assert.deepEqual(childExecutions.get(launched.id), {
    cwd: selectedWorktree,
    canary: "selected worktree\n",
    edit: `child-edit-${launched.id}.txt`,
  }, "the launched child executes and edits inside the inherited selected worktree");
  const runningView = await gateway.agentState();
  assert.equal(runningView.footer, "● 1 running    /agent-state");
  assert.deepEqual(
    runningView.runs.map((run) => [run.id, run.status.glyph, run.status.text, run.category]),
    [[launched.id, "●", "running", "active"]],
    "Gateway clients receive the shared run-view contract instead of runtime rows",
  );

  // --- parent stays responsive while the child runs (non-blocking) ------------------------
  assert.equal(
    (await gateway.sessionState()).find(({ id }) => id === "operator-thread")?.state,
    "working",
    "the parent remains responsive and effectively working while its child runs",
  );
  assert.equal((await gateway.listAgentRuns("operator-thread")).length, 1, "runs list by parent thread");

  // --- explicit cwd: the child override remains unchanged through tool → HTTP → ledger -----
  const explicitResult = await delegateAgentTool.execute(
    "delegate-explicit-cwd",
    {
      harness: AgentRunHarness.ClaudeCode,
      task: "work in an explicit child directory",
      cwd: explicitChildCwd,
    },
    undefined,
    undefined,
    toolContext,
  );
  const explicitRun = explicitResult.details as AgentRun;
  assert.equal(explicitRun.cwd, explicitChildCwd, "an explicit child cwd is recorded unchanged");
  assert.equal(explicitRun.parentThreadId, "operator-thread", "explicit cwd does not replace parent identity");
  await waitFor(() => parked.some(({ request }) => request.run.id === explicitRun.id), 3_000, "explicit child to start");
  assert.deepEqual(childExecutions.get(explicitRun.id), {
    cwd: explicitChildCwd,
    canary: "explicit child\n",
    edit: `child-edit-${explicitRun.id}.txt`,
  }, "the explicit child executes and edits only in its requested cwd");
  parked.find(({ request }) => request.run.id === explicitRun.id)!.finish({
    status: AgentRunStatus.Completed,
    resultText: "explicit child done",
    error: null,
  });
  assert.equal((await gateway.waitAgentRun(explicitRun.id, 5)).status, AgentRunStatus.Completed);

  // --- graceful shutdown mid-run leaves a DURABLE interrupted row, never lost -------------
  unsubscribe();
  await daemon.close();
  parked.length = 0;

  // --- restart on the same state: the run reconciled to interrupted, its result not lost --
  daemon = await startOnce();
  assert.equal(startupReaps, 2, "every daemon incarnation performs startup reaping");
  gateway2 = (await connectGateway())!;
  const afterRestart = await gateway2.agentRun(launched.id);
  assert.equal(afterRestart.status, AgentRunStatus.Interrupted, "the interrupted run survives restart");
  assert.ok(afterRestart.childSessionId, "the child identity survives for retry");
  assert.equal(afterRestart.cwd, selectedWorktree, "restart preserves the originally recorded child cwd");
  assert.equal(
    (await gateway2.sessionState()).find(({ id }) => id === "operator-thread")?.state,
    "needs-you",
    "a terminal child restores the root's transcript-derived state through Gateway",
  );
  const restartedView = await gateway2.agentState();
  assert.equal(restartedView.footer, "! 1 attention    /agent-state");
  assert.equal(restartedView.runs[0]?.status.text, "attention");
  assert.equal(restartedView.runs[0]?.canRetry, true, "restart reconstructs the durable retryable outcome");

  // --- retry over HTTP: a new run under the same child identity ---------------------------
  const retried = await gateway2.retryAgentRun(launched.id);
  assert.equal(retried.retryOfRunId, launched.id, "retry records the exact run");
  assert.equal(retried.childSessionId, afterRestart.childSessionId, "retry reuses the child identity");
  assert.equal(retried.cwd, launched.cwd, "retry copies the immutable cwd from the original child run");
  await waitFor(() => parked.length === 1, 3_000, "retried child to start");
  assert.equal(parked[0].request.run.cwd, selectedWorktree, "the retried child executes in the original cwd");
  assert.equal(childExecutions.get(retried.id)?.cwd, selectedWorktree);
  assert.deepEqual(parked[0].request.turnIntent, {
    kind: "retry",
    childSessionId: afterRestart.childSessionId,
    acpxRecordId: afterRestart.acpxRecordId,
  }, "the launcher is asked to retry it");

  // --- receive the durable result ---------------------------------------------------------
  parked[0].finish({ status: AgentRunStatus.Completed, resultText: "found the race", error: null });
  const done = await gateway2.waitAgentRun(retried.id, 5);
  assert.equal(done.status, AgentRunStatus.Completed);
  assert.equal(done.resultTail, "found the race", "the durable result is delivered through the ledger");

  // --- resume a completed run over HTTP with strict task validation ----------------------
  const daemonInfo = JSON.parse(readFileSync(join(ooHome, "daemon.json"), "utf8")) as {
    port: number;
    authToken: string;
  };
  const missingTask = await fetch(`http://127.0.0.1:${daemonInfo.port}/agent-runs/${done.id}/resume`, {
    method: "POST",
    headers: { authorization: `Bearer ${daemonInfo.authToken}`, "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(missingTask.status, 400, "Gateway rejects resume without a new task");
  assert.equal(
    (await missingTask.json() as { error?: unknown }).error,
    AGENT_RUN_RESUME_TASK_ERROR,
  );

  parked.length = 0;
  const resumed = await gateway2.resumeAgentRun(done.id, "explain the owner impact");
  assert.equal(resumed.task, "explain the owner impact");
  assert.equal(resumed.resumeOfRunId, done.id);
  assert.equal(resumed.childSessionId, done.childSessionId);
  assert.equal(resumed.acpxRecordId, done.acpxRecordId);
  assert.equal(resumed.model, done.model);
  assert.equal(resumed.effort, done.effort);
  assert.equal(resumed.timeoutSeconds, done.timeoutSeconds);
  assert.equal(resumed.cwd, launched.cwd, "resume copies the immutable cwd from the completed child run");
  await waitFor(() => parked.length === 1, 3_000, "resumed child to start");
  assert.equal(parked[0].request.run.cwd, selectedWorktree, "the resumed child executes in the original cwd");
  assert.equal(childExecutions.get(resumed.id)?.cwd, selectedWorktree);
  assert.deepEqual(parked[0].request.turnIntent, {
    kind: "resume",
    childSessionId: done.childSessionId,
    acpxRecordId: done.acpxRecordId,
  });
  parked[0].finish({ status: AgentRunStatus.Completed, resultText: "owner impact explained", error: null });
  const resumedDone = await gateway2.waitAgentRun(resumed.id, 5);
  assert.equal(resumedDone.status, AgentRunStatus.Completed);
  assert.equal((await gateway2.agentRun(done.id)).resultTail, "found the race", "resume never mutates the completed run");

  // --- cancel a fresh run over HTTP -------------------------------------------------------
  parked.length = 0;
  const toCancel = await gateway2.delegateAgent({
    harness: AgentRunHarness.Codex,
    task: "audit deps",
    cwd: explicitChildCwd,
  });
  await waitFor(() => parked.length === 1, 3_000, "cancellable child to start");
  const cancelled = await gateway2.cancelAgentRun(toCancel.id);
  assert.equal(cancelled.status, AgentRunStatus.Cancelled, "cancel returns the cancelled run row");
  assert.equal((await gateway2.agentRun(toCancel.id)).status, AgentRunStatus.Cancelled, "cancel is durable");

  // --- SSE carried delegated-run invalidations --------------------------------------------
  assert.ok(
    sseEvents.some((event) => event.kind === GatewayEventKind.AgentRunChanged),
    "the daemon pushed agent-run invalidations over SSE",
  );

  const finalCheckoutStatus = gitStatus(daemonCheckout);
  const finalSelectedStatus = gitStatus(selectedWorktree);
  assert.equal(finalCheckoutStatus, initialCheckoutStatus,
    "root and delegated edits leave the checkout running OO clean");
  assert.equal(readFileSync(join(daemonCheckout, "canary.txt"), "utf8"), initialCheckoutCanary,
    "the checkout canary is unchanged");
  assert.notEqual(finalSelectedStatus, initialSelectedStatus, "the selected worktree records the root and child edits");
  assert.equal(readFileSync(join(selectedWorktree, "canary.txt"), "utf8"), initialSelectedCanary,
    "the selected-worktree canary survives root, child, retry, and resume execution");
  for (const edit of [rootExecution.edit, ...[launched.id, retried.id, resumed.id].map((id) => `child-edit-${id}.txt`)]) {
    assert.equal(readFileSync(join(selectedWorktree, edit), "utf8").length > 0, true,
      `${edit} exists in the selected worktree`);
    assert.throws(() => readFileSync(join(daemonCheckout, edit)), { code: "ENOENT" },
      `${edit} never lands in the checkout running OO`);
  }
  assert.equal(readFileSync(join(explicitChildCwd, `child-edit-${explicitRun.id}.txt`), "utf8").length > 0, true,
    "the explicitly rooted child edit stays in its own directory");
  assert.throws(() => readFileSync(join(selectedWorktree, `child-edit-${explicitRun.id}.txt`)), { code: "ENOENT" },
    "the explicitly rooted child edit never lands in the selected worktree");

  process.stdout.write(
    "ok — delegated run inherits root cwd and preserves explicit/retry/resume isolation over daemon HTTP\n",
  );
} finally {
  gateway?.close();
  gateway2?.close();
  await daemon.close();
  process.chdir(invocationCwd);
  cleanup();
}
