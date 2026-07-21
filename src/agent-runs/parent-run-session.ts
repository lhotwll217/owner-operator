import {
  AgentRunStatus,
  GatewayEventKind,
  isTerminalAgentRunStatus,
  type AgentRun,
  type GatewayApi,
} from "@owner-operator/core";
import {
  createAgentRunCompletionEnvelope,
  deriveParentAgentState,
  type AgentRunCompletionEnvelope,
  type ParentAgentStateView,
} from "@owner-operator/core/agent-state";

/** Parent-scoped transport seam. The production Gateway and tests use the same contract. */
export interface ParentRunAdapter {
  list(parentThreadId: string): Promise<AgentRun[]>;
  subscribe(listener: () => void): () => void;
  cancel(runId: string): Promise<AgentRun>;
  resume(runId: string): Promise<AgentRun>;
}

export interface ParentCompletionDeliveryResult {
  /** Event IDs whose custom messages are confirmed in the parent transcript. */
  delivered: readonly string[];
  /** Event IDs already present in the parent transcript before this delivery attempt. */
  duplicate: readonly string[];
  /** Event IDs accepted by Pi's follow-up queue but not yet persisted in the transcript. */
  queued: readonly string[];
}

/** Narrow parent-thread completion seam. Pi and tests consume the same bounded envelopes. */
export interface ParentCompletionAdapter {
  deliver(envelopes: readonly AgentRunCompletionEnvelope[]): Promise<ParentCompletionDeliveryResult>;
}

export interface ParentRunSessionOptions {
  now?: () => string;
  recentLimit?: number;
  completionAdapter?: ParentCompletionAdapter;
  /** Routine completed runs batch for approximately two seconds in production. */
  successBatchDelayMs?: number;
  /** Base delay for bounded durable-refetch retries after failed or unconfirmed delivery. */
  completionRetryDelayMs?: number;
  onError?: (error: unknown) => void;
}

type ViewListener = (view: ParentAgentStateView) => void;

const MAX_COMPLETION_DELIVERY_ATTEMPTS = 3;

/**
 * One open parent thread's live projection over its complete delegated-run fleet.
 *
 * Gateway events are invalidations only. A burst during an in-flight list marks the
 * projection dirty, so one further complete parent list always follows it.
 */
export class ParentRunSession {
  private readonly runs = new Map<string, AgentRun>();
  private readonly listeners = new Set<ViewListener>();
  private readonly now: () => string;
  private readonly recentLimit: number | undefined;
  private readonly completionAdapter: ParentCompletionAdapter | undefined;
  private readonly successBatchDelayMs: number;
  private readonly completionRetryDelayMs: number;
  private readonly onError: (error: unknown) => void;
  private readonly pendingCompletionIds = new Set<string>();
  private readonly settledCompletionIds = new Set<string>();
  private readonly completionDeliveryAttempts = new Map<string, number>();
  private readonly completionDeliveryExhaustionReported = new Set<string>();
  private readonly successBatch = new Map<string, AgentRunCompletionEnvelope>();
  private readonly completionPromises = new Set<Promise<void>>();
  private successBatchTimer?: ReturnType<typeof setTimeout>;
  private completionRetryTimer?: ReturnType<typeof setTimeout>;
  private unsubscribeAdapter?: () => void;
  private reconcilePromise?: Promise<void>;
  private dirty = false;
  private started = false;
  private stopped = false;

  constructor(
    private readonly parentThreadId: string,
    private readonly adapter: ParentRunAdapter,
    options: ParentRunSessionOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.recentLimit = options.recentLimit;
    this.completionAdapter = options.completionAdapter;
    this.successBatchDelayMs = Math.max(0, options.successBatchDelayMs ?? 2_000);
    this.completionRetryDelayMs = Math.max(0, options.completionRetryDelayMs ?? 1_000);
    this.onError = options.onError ?? (() => undefined);
  }

  get view(): ParentAgentStateView {
    return deriveParentAgentState([...this.runs.values()], {
      now: this.now(),
      ...(this.recentLimit === undefined ? {} : { recentLimit: this.recentLimit }),
    });
  }

  /** List durable truth, open one subscription, then list again to close the attachment gap. */
  async start(): Promise<void> {
    if (this.started) return;
    if (this.stopped) throw new Error("a stopped parent run session cannot be restarted");
    const initial = await this.adapter.list(this.parentThreadId);
    this.reconcile(initial);
    this.started = true;
    this.unsubscribeAdapter = this.adapter.subscribe(() => {
      this.resetCompletionRetryBudget();
      void this.refresh();
    });
    await this.refresh();
  }

  subscribe(listener: ViewListener): () => void {
    this.listeners.add(listener);
    listener(this.view);
    return () => this.listeners.delete(listener);
  }

  /** Resolve after all currently required coalesced lists have settled. */
  async settled(): Promise<void> {
    while (this.reconcilePromise) await this.reconcilePromise;
    while (this.completionPromises.size) await Promise.all(this.completionPromises);
  }

  async cancel(runId: string): Promise<void> {
    const selected = this.view.runs.find(({ id }) => id === runId);
    if (!selected?.canCancel) throw new Error(`agent run ${runId} cannot be cancelled`);
    this.reconcileOne(await this.adapter.cancel(runId));
    await this.refresh();
  }

  async resume(runId: string): Promise<void> {
    const selected = this.view.runs.find(({ id }) => id === runId);
    if (!selected?.canResume) throw new Error(`agent run ${runId} cannot be resumed`);
    this.reconcileOne(await this.adapter.resume(runId));
    await this.refresh();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.dirty = false;
    if (this.successBatchTimer) clearTimeout(this.successBatchTimer);
    this.successBatchTimer = undefined;
    if (this.completionRetryTimer) clearTimeout(this.completionRetryTimer);
    this.completionRetryTimer = undefined;
    this.successBatch.clear();
    this.completionDeliveryAttempts.clear();
    this.completionDeliveryExhaustionReported.clear();
    this.unsubscribeAdapter?.();
    this.unsubscribeAdapter = undefined;
    this.listeners.clear();
  }

  private refresh(): Promise<void> {
    if (!this.started || this.stopped) return Promise.resolve();
    if (this.reconcilePromise) {
      this.dirty = true;
      return this.reconcilePromise;
    }
    this.reconcilePromise = (async () => {
      try {
        do {
          this.dirty = false;
          try {
            this.reconcile(await this.adapter.list(this.parentThreadId));
          } catch (error) {
            this.onError(error);
          }
        } while (this.dirty && !this.stopped);
      } finally {
        this.reconcilePromise = undefined;
      }
    })();
    return this.reconcilePromise;
  }

  private reconcile(rows: readonly AgentRun[]): void {
    const next = new Map(
      rows.filter((run) => run.parentThreadId === this.parentThreadId).map((run) => [run.id, run]),
    );
    for (const [id, previous] of this.runs) {
      const incoming = next.get(id);
      if (!incoming || !acceptsTransition(previous, incoming)) {
        next.set(id, previous);
      }
    }
    this.runs.clear();
    for (const [id, run] of next) this.runs.set(id, run);
    this.notify();
    this.reconcileCompletions(next.values());
  }

  private reconcileOne(run: AgentRun): void {
    if (run.parentThreadId !== this.parentThreadId) return;
    const previous = this.runs.get(run.id);
    if (previous && !acceptsTransition(previous, run)) return;
    this.runs.set(run.id, run);
    this.notify();
  }

  private notify(): void {
    const view = this.view;
    for (const listener of this.listeners) {
      try { listener(view); } catch { /* one surface consumer must not break reconciliation */ }
    }
  }

  private reconcileCompletions(runs: Iterable<AgentRun>): void {
    if (!this.completionAdapter || this.stopped) return;
    for (const run of runs) {
      if (run.parentThreadId !== this.parentThreadId || !isTerminalAgentRunStatus(run.status) || !run.finishedAt) continue;
      const envelope = createAgentRunCompletionEnvelope(run);
      if (this.pendingCompletionIds.has(envelope.eventId) || this.settledCompletionIds.has(envelope.eventId)) continue;
      if ((this.completionDeliveryAttempts.get(envelope.eventId) ?? 0) >= MAX_COMPLETION_DELIVERY_ATTEMPTS) continue;
      this.pendingCompletionIds.add(envelope.eventId);
      if (run.status === AgentRunStatus.Completed && this.successBatchDelayMs > 0) {
        this.successBatch.set(envelope.eventId, envelope);
        this.successBatchTimer ??= setTimeout(() => this.flushSuccessBatch(), this.successBatchDelayMs);
      } else {
        this.dispatchCompletions([envelope]);
      }
    }
  }

  private flushSuccessBatch(): void {
    this.successBatchTimer = undefined;
    if (this.stopped || !this.successBatch.size) return;
    const batch = [...this.successBatch.values()];
    this.successBatch.clear();
    this.dispatchCompletions(batch);
  }

  private dispatchCompletions(envelopes: readonly AgentRunCompletionEnvelope[]): void {
    if (!this.completionAdapter || this.stopped || !envelopes.length) return;
    const eventIds = envelopes.map(({ eventId }) => eventId);
    const delivery = this.completionAdapter.deliver(envelopes)
      .then(({ delivered, duplicate, queued }) => {
        const settled = new Set([...delivered, ...duplicate]);
        const pendingInPi = new Set(queued);
        for (const eventId of eventIds) {
          if (settled.has(eventId)) {
            this.settledCompletionIds.add(eventId);
            this.completionDeliveryAttempts.delete(eventId);
          }
        }
        this.scheduleCompletionRetry(
          eventIds.filter((eventId) => !settled.has(eventId) && !pendingInPi.has(eventId)),
        );
      })
      .catch((error) => {
        this.onError(error);
        this.scheduleCompletionRetry(eventIds);
      })
      .finally(() => {
        for (const eventId of eventIds) this.pendingCompletionIds.delete(eventId);
        this.completionPromises.delete(delivery);
      });
    this.completionPromises.add(delivery);
  }

  /** Retry with bounded backoff; each attempt still starts from the durable parent fleet. */
  private scheduleCompletionRetry(eventIds: readonly string[]): void {
    if (this.stopped || !this.completionAdapter || !eventIds.length) return;
    let nextAttempt = MAX_COMPLETION_DELIVERY_ATTEMPTS;
    for (const eventId of eventIds) {
      const attempt = (this.completionDeliveryAttempts.get(eventId) ?? 0) + 1;
      this.completionDeliveryAttempts.set(eventId, attempt);
      if (attempt >= MAX_COMPLETION_DELIVERY_ATTEMPTS) {
        this.reportCompletionDeliveryExhausted(eventId);
      }
      nextAttempt = Math.min(nextAttempt, attempt);
    }
    if (nextAttempt >= MAX_COMPLETION_DELIVERY_ATTEMPTS || this.completionRetryTimer) return;
    const delayMs = this.completionRetryDelayMs * 2 ** (nextAttempt - 1);
    this.completionRetryTimer = setTimeout(() => {
      this.completionRetryTimer = undefined;
      void this.refresh();
    }, delayMs);
    this.completionRetryTimer.unref?.();
  }

  private resetCompletionRetryBudget(): void {
    this.completionDeliveryAttempts.clear();
    if (this.completionRetryTimer) clearTimeout(this.completionRetryTimer);
    this.completionRetryTimer = undefined;
  }

  private reportCompletionDeliveryExhausted(eventId: string): void {
    if (this.completionDeliveryExhaustionReported.has(eventId)) return;
    this.completionDeliveryExhaustionReported.add(eventId);
    this.onError(new Error(
      `Delegated-run completion ${eventId} could not be delivered after ${MAX_COMPLETION_DELIVERY_ATTEMPTS} attempts. Reopen this parent thread to retry delivery.`,
    ));
  }
}

function acceptsTransition(previous: AgentRun, incoming: AgentRun): boolean {
  return !isTerminalAgentRunStatus(previous.status)
    || (isTerminalAgentRunStatus(incoming.status) && incoming.status === previous.status);
}

/** Production adapter: one Gateway subscription is shared by every run in the parent session. */
export function gatewayParentRunAdapter(
  gateway: Pick<GatewayApi, "listAgentRuns" | "cancelAgentRun" | "resumeAgentRun" | "subscribe">,
): ParentRunAdapter {
  return {
    list: (parentThreadId) => gateway.listAgentRuns(parentThreadId),
    subscribe: (listener) => gateway.subscribe(
      (event) => { if (event.kind === GatewayEventKind.AgentRunChanged) listener(); },
      listener,
    ),
    cancel: (runId) => gateway.cancelAgentRun(runId),
    resume: (runId) => gateway.resumeAgentRun(runId),
  };
}
