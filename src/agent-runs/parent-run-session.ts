import {
  GatewayEventKind,
  isTerminalAgentRunStatus,
  type AgentRun,
  type GatewayApi,
} from "@owner-operator/core";
import {
  deriveParentAgentState,
  type ParentAgentStateView,
} from "@owner-operator/core/agent-state";

/** Parent-scoped transport seam. The production Gateway and tests use the same contract. */
export interface ParentRunAdapter {
  list(parentThreadId: string): Promise<AgentRun[]>;
  subscribe(listener: () => void): () => void;
  cancel(runId: string): Promise<AgentRun>;
  resume(runId: string): Promise<AgentRun>;
}

export interface ParentRunSessionOptions {
  now?: () => string;
  recentLimit?: number;
  onError?: (error: unknown) => void;
}

type ViewListener = (view: ParentAgentStateView) => void;

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
  private readonly onError: (error: unknown) => void;
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
    this.unsubscribeAdapter = this.adapter.subscribe(() => { void this.refresh(); });
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
      do {
        this.dirty = false;
        try {
          this.reconcile(await this.adapter.list(this.parentThreadId));
        } catch (error) {
          this.onError(error);
        }
      } while (this.dirty && !this.stopped);
    })().finally(() => {
      this.reconcilePromise = undefined;
    });
    return this.reconcilePromise;
  }

  private reconcile(rows: readonly AgentRun[]): void {
    const next = new Map(rows.map((run) => [run.id, run]));
    for (const [id, previous] of this.runs) {
      const incoming = next.get(id);
      if (!incoming || !acceptsTransition(previous, incoming)) {
        next.set(id, previous);
      }
    }
    this.runs.clear();
    for (const [id, run] of next) this.runs.set(id, run);
    this.notify();
  }

  private reconcileOne(run: AgentRun): void {
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
