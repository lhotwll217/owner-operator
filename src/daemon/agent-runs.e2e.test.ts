// End-to-end fixture for issue #69: drive a delegated run through the whole daemon HTTP
// surface — launch, observe live state while the parent stays responsive, restart and
// reconcile to a durable interrupted state, resume to the same child identity, receive the
// durable result, and cancel a run. The child process itself is a controllable fake launcher;
// the opt-in acp-launcher.live.test.ts drives the same path through real Claude/acpx. The
// crash-vs-graceful reconciliation on start() is also covered in executor.integration.test.ts.
import assert from "node:assert";
import { readFileSync } from "node:fs";
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
import { tempOoHome, waitFor } from "../gateway/test/helpers";
import { startDaemon } from "./runtime";

const { dir: ooHome, cleanup } = tempOoHome("oo-agent-runs-e2e");
approveDelegatedBaseline(AgentRunHarness.ClaudeCode, { model: "test-claude", effort: null }, ooHome);
approveDelegatedBaseline(AgentRunHarness.Codex, { model: "test-codex", effort: "high" }, ooHome);

// A controllable launcher shared across daemon incarnations: each launch parks on a promise
// the test resolves (or the executor aborts on stop/cancel). It reports the child's ACP
// identity the way the real acpx bridge does.
const parked: Array<{ request: AgentRunLaunchRequest; finish: (r: AgentRunLaunchResult) => void }> = [];
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
  monitor: { scan: async () => [], intervalMs: 60_000 },
  scheduler: { tickMs: 60_000 },
  agentRuns: { launcher, tickMs: 20, maxConcurrent: 3, logger: () => undefined },
});

let daemon = await startOnce();
type GatewayConn = NonNullable<Awaited<ReturnType<typeof connectGateway>>>;
const toolContext = {
  sessionManager: { getSessionId: () => "operator-thread" },
} as Parameters<typeof delegateAgentTool.execute>[4];
let gateway: GatewayConn | undefined;
let gateway2: GatewayConn | undefined;
try {
  assert.equal(startupReaps, 1, "daemon startup reaps stale delegated process trees before launch");
  gateway = (await connectGateway())!;
  assert.ok(gateway, "ready daemon is discoverable");

  const sseEvents: GatewayEvent[] = [];
  const unsubscribe = gateway.subscribe((event) => sseEvents.push(event));

  // --- launch through the Operator tool: trusted context supplies parent lineage -----------
  const launchResult = await delegateAgentTool.execute(
    "delegate-test",
    {
      harness: AgentRunHarness.ClaudeCode,
      task: "research flaky test",
      cwd: process.cwd(),
    },
    undefined,
    undefined,
    toolContext,
  );
  const launched = launchResult.details as AgentRun;
  assert.equal(launched.status, AgentRunStatus.Pending, "delegate returns before the child runs");
  assert.equal(launched.depth, 1);
  assert.equal(launched.parentThreadId, "operator-thread", "the Operator tool binds trusted parent lineage");

  // The launcher records activity synchronously before parking, so once the child is parked
  // the ledger row is already running — parked.length is the real synchronization point.
  await waitFor(() => parked.length === 1, 3_000, "child to start");
  const running = await gateway.agentRun(launched.id);
  assert.equal(running.status, AgentRunStatus.Running);
  assert.equal(running.activity, "child started", "explicit activity is captured in the ledger");
  assert.equal(running.childSessionId, "child-research-flaky-test", "child identity captured at spawn");
  const runningView = await gateway.agentState();
  assert.equal(runningView.footer, "● 1 running    /agent-state");
  assert.deepEqual(
    runningView.runs.map((run) => [run.id, run.status.glyph, run.status.text, run.category]),
    [[launched.id, "●", "running", "active"]],
    "Gateway clients receive the shared run-view contract instead of runtime rows",
  );

  // --- parent stays responsive while the child runs (non-blocking) ------------------------
  assert.deepEqual(await gateway.sessionState(), [], "the parent can still call the gateway mid-run");
  assert.equal((await gateway.listAgentRuns("operator-thread")).length, 1, "runs list by parent thread");

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
  const restartedView = await gateway2.agentState();
  assert.equal(restartedView.footer, "! 1 attention    /agent-state");
  assert.equal(restartedView.runs[0]?.status.text, "attention");
  assert.equal(restartedView.runs[0]?.canRetry, true, "restart reconstructs the durable retryable outcome");

  // --- retry over HTTP: a new run under the same child identity ---------------------------
  const retried = await gateway2.retryAgentRun(launched.id);
  assert.equal(retried.retryOfRunId, launched.id, "retry records the exact run");
  assert.equal(retried.childSessionId, afterRestart.childSessionId, "retry reuses the child identity");
  await waitFor(() => parked.length === 1, 3_000, "retried child to start");
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
  await waitFor(() => parked.length === 1, 3_000, "resumed child to start");
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
    cwd: process.cwd(),
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

  process.stdout.write("ok — delegated run drives launch → retry → resume → result → cancel over daemon HTTP\n");
} finally {
  gateway?.close();
  gateway2?.close();
  await daemon.close();
  cleanup();
}
