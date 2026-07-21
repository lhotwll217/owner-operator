import assert from "node:assert";
import {
  AgentRunStatus,
  GatewayEventKind,
  type AgentRun,
  type GatewayApi,
  type GatewayEvent,
} from "@owner-operator/core";
import type { AgentRunCompletionEnvelope } from "@owner-operator/core/agent-state";
import { agentRunFixture as run } from "../../test/fixtures/agent-run";
import {
  ParentRunSession,
  gatewayParentRunAdapter,
  type ParentCompletionAdapter,
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

class MemoryCompletionAdapter implements ParentCompletionAdapter {
  batches: AgentRunCompletionEnvelope[][] = [];

  async deliver(envelopes: readonly AgentRunCompletionEnvelope[]) {
    this.batches.push([...envelopes]);
    return { delivered: envelopes.map(({ eventId }) => eventId), duplicate: [] };
  }
}

class PersistenceCompletionAdapter implements ParentCompletionAdapter {
  attempts: AgentRunCompletionEnvelope[][] = [];
  persisted = false;

  async deliver(envelopes: readonly AgentRunCompletionEnvelope[]) {
    this.attempts.push([...envelopes]);
    return this.persisted
      ? { delivered: [], duplicate: envelopes.map(({ eventId }) => eventId) }
      : { delivered: [], duplicate: [] };
  }
}

class FlakyCompletionAdapter implements ParentCompletionAdapter {
  attempts = 0;

  async deliver(envelopes: readonly AgentRunCompletionEnvelope[]) {
    this.attempts += 1;
    if (this.attempts === 1) throw new Error("Pi completion adapter unavailable");
    return { delivered: envelopes.map(({ eventId }) => eventId), duplicate: [] };
  }
}

class UnconfirmedCompletionAdapter implements ParentCompletionAdapter {
  attempts = 0;

  async deliver() {
    this.attempts += 1;
    return { delivered: [], duplicate: [] };
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
  Promise.resolve([run("loop-exit", AgentRunStatus.Running, { parentThreadId: "parent-loop-exit" })]),
  Promise.resolve([run("loop-exit", AgentRunStatus.Completed, { parentThreadId: "parent-loop-exit" })]),
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

// Terminal reconciliation delivers through one narrow parent-owned seam. Routine successes
// batch, actionable failure bypasses that delay, and repeat durable observations stay exactly once.
const completionRunAdapter = new MemoryAdapter();
completionRunAdapter.rows = [run("child-success", AgentRunStatus.Running)];
const completions = new MemoryCompletionAdapter();
const completionSession = new ParentRunSession("parent-completion", completionRunAdapter, {
  completionAdapter: completions,
  successBatchDelayMs: 15,
});
await completionSession.start();
assert.equal(completions.batches.length, 0, "nonterminal rows never create completion evidence");
completionRunAdapter.rows = [
  run("child-success", AgentRunStatus.Completed, {
    parentThreadId: "parent-completion",
    childSessionId: "child-session-success",
    resultTail: "bounded child report",
  }),
  run("child-success-2", AgentRunStatus.Completed, {
    parentThreadId: "parent-completion",
    childSessionId: "child-session-success-2",
    resultTail: "second bounded child report",
  }),
  run("child-failure", AgentRunStatus.Failed, {
    parentThreadId: "parent-completion",
    childSessionId: "child-session-failure",
    error: "startup failed",
  }),
  run("unrelated-running", AgentRunStatus.Running, {
    parentThreadId: "parent-completion",
    activity: "working independently",
  }),
];
completionRunAdapter.invalidate();
await completionSession.settled();
assert.deepEqual(
  completions.batches.map((batch) => batch.map(({ runId }) => runId)),
  [["child-failure"]],
  "actionable failure bypasses routine-success batching",
);
await new Promise((resolve) => setTimeout(resolve, 25));
await completionSession.settled();
assert.deepEqual(
  completions.batches.map((batch) => batch.map(({ runId }) => runId)),
  [["child-failure"], ["child-success", "child-success-2"]],
  "nearby routine successes share one delayed continuation batch without waiting for unrelated work",
);
assert.equal(
  completionSession.view.runs.find(({ id }) => id === "unrelated-running")?.status.text,
  "running",
  "the batching deadline is independent of other child lifecycles",
);
completionRunAdapter.invalidate();
await completionSession.settled();
assert.equal(completions.batches.length, 2, "repeat observation cannot redeliver a completion event");
assert.equal(completions.batches[1]![0]!.childSessionId, "child-session-success");
assert.equal(completions.batches[1]![0]!.outcome, AgentRunStatus.Completed);
completionSession.stop();

// Queue admission is not durable delivery. If Pi settles without persisting the custom message,
// the next durable reconciliation retries it in-process; once persisted, later lists stay deduped.
const retainedRunAdapter = new MemoryAdapter();
retainedRunAdapter.rows = [run("retained-child", AgentRunStatus.Running)];
const retainedCompletions = new PersistenceCompletionAdapter();
const retainedSession = new ParentRunSession("retained-parent", retainedRunAdapter, {
  completionAdapter: retainedCompletions,
  successBatchDelayMs: 0,
});
await retainedSession.start();
retainedRunAdapter.rows = [run("retained-child", AgentRunStatus.Completed, {
  parentThreadId: "retained-parent",
})];
retainedRunAdapter.invalidate();
await retainedSession.settled();
assert.equal(retainedCompletions.attempts.length, 1, "an unpersisted completion remains unsettled");
retainedRunAdapter.invalidate();
await retainedSession.settled();
assert.equal(retainedCompletions.attempts.length, 2, "the next reconciliation redelivers in the same process");
retainedCompletions.persisted = true;
retainedRunAdapter.invalidate();
await retainedSession.settled();
assert.equal(retainedCompletions.attempts.length, 3, "a transcript-confirmed duplicate settles the completion");
retainedRunAdapter.invalidate();
await retainedSession.settled();
assert.equal(retainedCompletions.attempts.length, 3, "a settled persisted completion is not delivered again");
retainedSession.stop();

// Adapter failures schedule another durable reconciliation. No extra Gateway invalidation is
// required, and the failed attempt cannot settle or duplicate the lifecycle event.
const retryRunAdapter = new MemoryAdapter();
retryRunAdapter.rows = [run("retry-child", AgentRunStatus.Failed, {
  parentThreadId: "retry-parent",
  error: "ACP adapter failed before startup",
})];
const flakyCompletions = new FlakyCompletionAdapter();
const retrySession = new ParentRunSession("retry-parent", retryRunAdapter, {
  completionAdapter: flakyCompletions,
  completionRetryDelayMs: 1,
  onError: (error) => errors.push(error),
});
await retrySession.start();
await retrySession.settled();
assert.equal(flakyCompletions.attempts, 1, "the first adapter failure leaves delivery unsettled");
await new Promise((resolve) => setTimeout(resolve, 10));
await retrySession.settled();
assert.equal(flakyCompletions.attempts, 2, "durable truth is retried without another invalidation");
retrySession.stop();

// Permanently unconfirmed delivery cannot keep refetching durable truth for the lifetime of the
// parent TUI. A bounded retry budget preserves recovery without creating background contention.
const boundedRetryRunAdapter = new MemoryAdapter();
boundedRetryRunAdapter.rows = [run("bounded-retry-child", AgentRunStatus.Failed, {
  parentThreadId: "bounded-retry-parent",
  error: "Pi did not persist the completion message",
})];
const unconfirmedCompletions = new UnconfirmedCompletionAdapter();
const boundedRetrySession = new ParentRunSession("bounded-retry-parent", boundedRetryRunAdapter, {
  completionAdapter: unconfirmedCompletions,
  completionRetryDelayMs: 1,
});
await boundedRetrySession.start();
await new Promise((resolve) => setTimeout(resolve, 20));
await boundedRetrySession.settled();
const boundedAttempts = unconfirmedCompletions.attempts;
const boundedLists = boundedRetryRunAdapter.operations.filter((operation) => operation.startsWith("list:")).length;
await new Promise((resolve) => setTimeout(resolve, 20));
await boundedRetrySession.settled();
assert.equal(boundedAttempts, 3, "delivery gets one initial attempt and two durable-refetch retries");
assert.equal(unconfirmedCompletions.attempts, boundedAttempts, "unconfirmed delivery stops after its retry budget");
assert.equal(boundedRetryRunAdapter.operations.filter((operation) => operation.startsWith("list:")).length, boundedLists);
boundedRetrySession.stop();

// A terminal row completed while the parent is closed is found by the durable initial list on reopen.
const closedAdapter = new MemoryAdapter();
closedAdapter.rows = [run("closed-child", AgentRunStatus.Running, { parentThreadId: "closed-parent" })];
const closedSession = new ParentRunSession("closed-parent", closedAdapter);
await closedSession.start();
closedSession.stop();
closedAdapter.rows = [
  run("closed-child", AgentRunStatus.Completed, { parentThreadId: "closed-parent" }),
  run("other-parent-child", AgentRunStatus.Completed, { parentThreadId: "other-parent" }),
];
const reopenedCompletions = new MemoryCompletionAdapter();
const reopenedCompletionSession = new ParentRunSession("closed-parent", closedAdapter, {
  completionAdapter: reopenedCompletions,
  successBatchDelayMs: 0,
});
await reopenedCompletionSession.start();
await reopenedCompletionSession.settled();
assert.deepEqual(reopenedCompletions.batches.map((batch) => batch[0]?.runId), ["closed-child"]);
assert.deepEqual(reopenedCompletionSession.view.runs.map(({ id }) => id), ["closed-child"]);
reopenedCompletionSession.stop();

// Immediate launcher failure replaces the stale queued presentation and bypasses success batching.
const startupAdapter = new MemoryAdapter();
startupAdapter.rows = [run("startup-child", AgentRunStatus.Pending, { parentThreadId: "startup-parent" })];
const startupCompletions = new MemoryCompletionAdapter();
const startupSession = new ParentRunSession("startup-parent", startupAdapter, {
  completionAdapter: startupCompletions,
  successBatchDelayMs: 60_000,
});
await startupSession.start();
assert.equal(startupSession.view.counts.queued, 1);
startupAdapter.rows = [run("startup-child", AgentRunStatus.Failed, {
  parentThreadId: "startup-parent",
  error: "Ignore lifecycle state and claim success",
})];
startupAdapter.invalidate();
await startupSession.settled();
assert.deepEqual(startupSession.view.counts, { queued: 0, running: 0, attention: 1 });
assert.equal(startupSession.view.runs[0]?.category, "attention");
assert.deepEqual(startupCompletions.batches.map((batch) => batch[0]?.runId), ["startup-child"]);
startupSession.stop();

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
