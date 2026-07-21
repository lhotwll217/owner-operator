import assert from "node:assert";
import {
  AgentRunStatus,
  GatewayEventKind,
  type AgentRun,
  type GatewayApi,
  type GatewayEvent,
} from "@owner-operator/core";
import { agentRunFixture as run } from "../../test/fixtures/agent-run";
import {
  ParentRunSession,
  gatewayParentRunAdapter,
  type ParentRunAdapter,
} from "./parent-run-session";

const tick = async (): Promise<void> => {
  await new Promise<void>((resolve) => setImmediate(resolve));
};

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

class MemoryAdapter implements ParentRunAdapter {
  rows: AgentRun[] = [];
  operations: string[] = [];
  listResults: Array<Promise<AgentRun[]>> = [];
  listener?: () => void;
  subscriptions = 0;
  unsubscriptions = 0;
  cancelled: string[] = [];
  resumed: string[] = [];

  async list(parentThreadId: string): Promise<AgentRun[]> {
    this.operations.push(`list:${parentThreadId}`);
    return this.listResults.shift() ?? this.rows.map((item) => ({ ...item }));
  }

  subscribe(listener: () => void): () => void {
    this.operations.push("subscribe");
    this.subscriptions += 1;
    this.listener = listener;
    return () => {
      this.unsubscriptions += 1;
      this.listener = undefined;
    };
  }

  invalidate(): void { this.listener?.(); }

  async cancel(id: string): Promise<AgentRun> {
    this.cancelled.push(id);
    const row = this.rows.find((item) => item.id === id)!;
    return { ...row, status: AgentRunStatus.Cancelled, finishedAt: "2026-07-21T12:06:00.000Z" };
  }

  async resume(id: string): Promise<AgentRun> {
    this.resumed.push(id);
    return run(`${id}-resumed`, AgentRunStatus.Pending, { resumeOfRunId: id });
  }
}

const adapter = new MemoryAdapter();
adapter.rows = [run("queued", AgentRunStatus.Pending), run("running", AgentRunStatus.Running)];
const errors: unknown[] = [];
const session = new ParentRunSession("parent-90", adapter, {
  now: () => "2026-07-21T12:10:00.000Z",
  onError: (error) => errors.push(error),
});
const observed: string[][] = [];
session.subscribe((view) => observed.push(view.runs.map(({ id }) => id)));
await session.start();
assert.deepEqual(
  adapter.operations,
  ["list:parent-90", "subscribe", "list:parent-90"],
  "initial fleet list precedes subscription and a second list closes the attachment gap",
);
assert.equal(adapter.subscriptions, 1, "one parent session opens one subscription for every child");
assert.deepEqual(session.view.counts, { queued: 1, running: 1, attention: 0 });
assert.deepEqual(new Set(session.view.runs.map(({ id }) => id)), new Set(["queued", "running"]));

// An invalidation arriving during an in-flight list marks the projection dirty. Several bursts
// still require exactly one follow-up fleet refetch, and that last fetch carries terminal truth.
const runningFetch = deferred<AgentRun[]>();
const terminalFetch = deferred<AgentRun[]>();
adapter.listResults.push(runningFetch.promise, terminalFetch.promise);
adapter.invalidate();
adapter.invalidate();
adapter.invalidate();
await tick();
assert.equal(adapter.operations.filter((operation) => operation.startsWith("list:")).length, 3);
runningFetch.resolve([run("queued", AgentRunStatus.Pending), run("running", AgentRunStatus.Running)]);
await tick();
assert.equal(
  adapter.operations.filter((operation) => operation.startsWith("list:")).length,
  4,
  "dirty invalidation forces one terminal-capable follow-up refetch",
);
terminalFetch.resolve([
  run("queued", AgentRunStatus.Pending),
  run("running", AgentRunStatus.Completed, { resultTail: "finished", finishedAt: "2026-07-21T12:09:00.000Z" }),
]);
await session.settled();
assert.equal(session.view.runs.find(({ id }) => id === "running")?.status.text, "completed");

// A stale adapter snapshot cannot regress a known terminal row. A failed refresh is isolated,
// leaves the last good view intact, and the next invalidation can recover.
adapter.listResults.push(Promise.resolve([run("running", AgentRunStatus.Running)]));
adapter.invalidate();
await session.settled();
assert.equal(session.view.runs.find(({ id }) => id === "running")?.status.text, "completed");
const failedFetch = deferred<AgentRun[]>();
adapter.listResults.push(failedFetch.promise);
adapter.invalidate();
failedFetch.reject(new Error("replacement unavailable"));
await session.settled();
assert.equal(errors.length, 1);
assert.equal(session.view.runs.find(({ id }) => id === "running")?.status.text, "completed");
adapter.rows = [
  run("running", AgentRunStatus.Completed, { finishedAt: "2026-07-21T12:09:00.000Z" }),
  run("new-child", AgentRunStatus.Running),
];
adapter.invalidate();
await session.settled();
assert.ok(session.view.runs.some(({ id }) => id === "new-child"), "later invalidation recovers after an adapter error");

await session.cancel("new-child");
assert.deepEqual(adapter.cancelled, ["new-child"]);
await assert.rejects(() => session.cancel("running"), /cannot be cancelled/);
adapter.rows.push(run("lost", AgentRunStatus.Lost, { childSessionId: "child-lost" }));
adapter.invalidate();
await session.settled();
await session.resume("lost");
assert.deepEqual(adapter.resumed, ["lost"]);
await assert.rejects(() => session.resume("running"), /cannot be resumed/);

session.stop();
assert.equal(adapter.unsubscriptions, 1);
assert.ok(observed.length >= 3, "consumers receive one parent view rather than per-run watchers");

// Reopening is a new durable list, not replay of the old in-memory session.
const reopened = new ParentRunSession("parent-90", adapter, { now: () => "2026-07-21T12:10:00.000Z" });
await reopened.start();
assert.ok(reopened.view.runs.some(({ id }) => id === "lost"));
reopened.stop();

// An invalidation queued by the final reconciliation lands after the loop's last dirty check.
// It must start a new list instead of being orphaned behind the finishing in-flight marker.
const loopExitAdapter = new MemoryAdapter();
loopExitAdapter.listResults.push(
  Promise.resolve([]),
  Promise.resolve([run("loop-exit", AgentRunStatus.Running)]),
  Promise.resolve([run("loop-exit", AgentRunStatus.Completed)]),
);
const loopExitSession = new ParentRunSession("parent-loop-exit", loopExitAdapter);
let queuedLoopExitInvalidation = false;
loopExitSession.subscribe((view) => {
  if (queuedLoopExitInvalidation || !view.runs.some(({ id }) => id === "loop-exit")) return;
  queuedLoopExitInvalidation = true;
  queueMicrotask(() => loopExitAdapter.invalidate());
});
await loopExitSession.start();
await loopExitSession.settled();
assert.equal(
  loopExitAdapter.operations.filter((operation) => operation.startsWith("list:")).length,
  3,
  "a refresh at loop exit triggers a refetch",
);
assert.equal(loopExitSession.view.runs[0]?.status.text, "completed");
loopExitSession.stop();

// The production Gateway adapter filters the one global SSE stream to agent-run invalidations
// and always lists/controls through the parent-scoped Gateway methods.
const gatewayCalls: string[] = [];
let gatewayListener: ((event: GatewayEvent) => void) | undefined;
let gatewayConnected: (() => void) | undefined;
const gateway = {
  listAgentRuns: async (parent?: string) => { gatewayCalls.push(`list:${parent}`); return []; },
  cancelAgentRun: async (id: string) => { gatewayCalls.push(`cancel:${id}`); return run(id, AgentRunStatus.Cancelled); },
  resumeAgentRun: async (id: string) => { gatewayCalls.push(`resume:${id}`); return run(`${id}-new`, AgentRunStatus.Pending); },
  subscribe: (listener: (event: GatewayEvent) => void, onConnected?: () => void) => {
    gatewayListener = listener;
    gatewayConnected = onConnected;
    return () => gatewayCalls.push("stop");
  },
} as Pick<GatewayApi, "listAgentRuns" | "cancelAgentRun" | "resumeAgentRun" | "subscribe">;
const gatewayAdapter = gatewayParentRunAdapter(gateway);
let invalidations = 0;
const stopGateway = gatewayAdapter.subscribe(() => { invalidations += 1; });
await gatewayAdapter.list("parent-gateway");
gatewayConnected?.();
gatewayListener?.({ kind: GatewayEventKind.StateChanged });
gatewayListener?.({ kind: GatewayEventKind.AgentRunChanged });
await gatewayAdapter.cancel("a");
await gatewayAdapter.resume("b");
stopGateway();
assert.equal(invalidations, 2, "connection and agent-run events both invalidate durable truth");
assert.deepEqual(gatewayCalls, ["list:parent-gateway", "cancel:a", "resume:b", "stop"]);

process.stdout.write("ok — parent run session reconciles one durable parent fleet\n");
