// End-to-end fixture for issue #69: drive a delegated run through the whole daemon HTTP
// surface — launch, observe live state while the parent stays responsive, restart and
// reconcile to a durable interrupted state, resume to the same child identity, receive the
// durable result, and cancel a run. The child process itself is a controllable fake launcher;
// the real ACP wire is the launcher seam (createAcpLauncher), typechecked against acpx. The
// crash-vs-graceful reconciliation on start() is covered in executor.integration.test.ts.
import assert from "node:assert";
import {
  type AgentRun,
  AgentRunHarness,
  AgentRunStatus,
  GatewayEventKind,
  type AgentRunLaunchRequest,
  type AgentRunLaunchResult,
  type GatewayEvent,
} from "@owner-operator/core";
import { delegateAgentTool } from "../agent/tools/delegate-agent";
import { connectGateway } from "../gateway/client";
import { tempOoHome, waitFor } from "../gateway/test/helpers";
import { startDaemon } from "./runtime";

const { cleanup } = tempOoHome("oo-agent-runs-e2e");

// A controllable launcher shared across daemon incarnations: each launch parks on a promise
// the test resolves (or the executor aborts on stop/cancel). It reports the child's ACP
// identity the way the real acpx bridge does.
const parked: Array<{ request: AgentRunLaunchRequest; finish: (r: AgentRunLaunchResult) => void }> = [];
const launcher = (request: AgentRunLaunchRequest): Promise<AgentRunLaunchResult> =>
  new Promise((resolve, reject) => {
    request.onActivity({
      activity: "child started",
      childSessionId: `child-${request.run.task.replace(/\W+/g, "-")}`,
    });
    const abort = (): void => reject(request.signal.reason ?? new Error("aborted"));
    if (request.signal.aborted) return abort();
    request.signal.addEventListener("abort", abort, { once: true });
    parked.push({ request, finish: resolve });
  });

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

  // --- parent stays responsive while the child runs (non-blocking) ------------------------
  assert.deepEqual(await gateway.sessionState(), [], "the parent can still call the gateway mid-run");
  assert.equal((await gateway.listAgentRuns("operator-thread")).length, 1, "runs list by parent thread");

  // --- graceful shutdown mid-run leaves a DURABLE interrupted row, never lost -------------
  unsubscribe();
  await daemon.close();
  parked.length = 0;

  // --- restart on the same state: the run reconciled to interrupted, its result not lost --
  daemon = await startOnce();
  gateway2 = (await connectGateway())!;
  const afterRestart = await gateway2.agentRun(launched.id);
  assert.equal(afterRestart.status, AgentRunStatus.Interrupted, "the interrupted run survives restart");
  assert.ok(afterRestart.childSessionId, "the child identity survives for resume");

  // --- resume over HTTP: a new run under the same child identity --------------------------
  const resumed = await gateway2.resumeAgentRun(launched.id);
  assert.equal(resumed.resumeOfRunId, launched.id, "resume records lineage");
  assert.equal(resumed.childSessionId, afterRestart.childSessionId, "resume reuses the child identity");
  await waitFor(() => parked.length === 1, 3_000, "resumed child to start");
  assert.equal(parked[0].request.resumeSessionId, afterRestart.childSessionId, "the launcher is asked to resume it");

  // --- receive the durable result ---------------------------------------------------------
  parked[0].finish({ status: AgentRunStatus.Completed, resultText: "found the race", error: null });
  const done = await gateway2.waitAgentRun(resumed.id, 5);
  assert.equal(done.status, AgentRunStatus.Completed);
  assert.equal(done.resultTail, "found the race", "the durable result is delivered through the ledger");

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

  process.stdout.write("ok — delegated run drives launch → interrupt → resume → result → cancel over the daemon HTTP surface\n");
} finally {
  gateway?.close();
  gateway2?.close();
  await daemon.close();
  cleanup();
}
