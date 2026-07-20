import { isAbsolute } from "node:path";
import {
  AGENT_RUN_CAPABILITIES,
  AGENT_RUN_MAX_DEPTH,
  AGENT_RUN_RESUMABLE_STATUSES,
  AgentRunStatus,
  DEFAULT_AGENT_RUN_TIMEOUT_SECONDS,
  MAX_AGENT_RUN_TIMEOUT_SECONDS,
  isTerminalAgentRunStatus,
  type AgentRun,
  type AgentRunCreateInput,
  type AgentRunFinalStatus,
  type AgentRunLaunchRequest,
  type AgentRunLaunchResult,
  type AgentRunOutcome,
} from "@owner-operator/core";
import type { State } from "../state/state";

const RESULT_TAIL_BYTES = 32 * 1024;
const WAIT_POLL_MS = 100;

export interface AgentRunLauncher {
  (request: AgentRunLaunchRequest): Promise<AgentRunLaunchResult>;
  /** Production launchers may own crash-surviving child process trees. */
  reapOrphans?(): Promise<void>;
}

export enum AgentRunExecutorLogEvent {
  RunFinished = "run-finished",
  StartupInterrupted = "startup-interrupted",
  RunsLost = "runs-lost",
  LoopFailed = "loop-failed",
}

export type AgentRunExecutorLogRecord =
  | { event: AgentRunExecutorLogEvent.RunFinished; runId: string; status: AgentRunStatus; error: string | null }
  | { event: AgentRunExecutorLogEvent.StartupInterrupted; count: number }
  | { event: AgentRunExecutorLogEvent.RunsLost; runIds: string[] }
  | { event: AgentRunExecutorLogEvent.LoopFailed; error: string };

export interface AgentRunExecutorOptions {
  launcher?: AgentRunLauncher;
  now?: () => number;
  tickMs?: number;
  maxConcurrent?: number;
  lostGraceMs?: number;
  logger?: (record: AgentRunExecutorLogRecord) => void;
}

const tail = (value: string): string => {
  const bytes = Buffer.from(value);
  if (bytes.length <= RESULT_TAIL_BYTES) return value;
  return `[truncated to last ${RESULT_TAIL_BYTES} bytes]\n${bytes.subarray(bytes.length - RESULT_TAIL_BYTES).toString()}`;
};

/** Why an active run was aborted; decides the terminal status it lands in. */
enum AbortIntent {
  Cancel = "cancel",
  Timeout = "timeout",
  Stop = "stop",
}

/** Daemon-owned delegated-run executor (issue #69). SQLite owns run rows; this class owns
 * execution: claim-under-cap queueing, the turn deadline, abort propagation, restart
 * interruption, and lost reconciliation. The launcher seam owns the child process — the
 * production launcher speaks ACP via acpx; tests inject a fake. Liveness is the in-process
 * active-turn set plus durable rows: persisted metadata alone never keeps a run alive. */
export class AgentRunExecutor {
  private readonly launcher: AgentRunLauncher;
  private readonly now: () => number;
  private readonly tickMs: number;
  private readonly maxConcurrent: number;
  private readonly lostGraceMs: number;
  private readonly logger: (record: AgentRunExecutorLogRecord) => void;
  private readonly active = new Map<string, { controller: AbortController; intent: AbortIntent | null }>();
  private timer: NodeJS.Timeout | null = null;
  private stopping = false;
  private draining: Promise<void> = Promise.resolve();

  constructor(private readonly state: State, options: AgentRunExecutorOptions = {}) {
    if (!options.launcher) throw new Error("agent-run executor requires a launcher");
    this.launcher = options.launcher;
    this.now = options.now ?? Date.now;
    this.tickMs = options.tickMs ?? 1_000;
    this.maxConcurrent = options.maxConcurrent ?? 3;
    this.lostGraceMs = options.lostGraceMs ?? 60_000;
    this.logger = options.logger ?? (() => undefined);
  }

  start(): void {
    if (this.timer) return;
    if (this.stopping) throw new Error("agent-run executor has been stopped");
    const interrupted = this.state.markRunningAgentRunsInterrupted("daemon restarted during execution");
    if (interrupted.length) {
      this.logger({ event: AgentRunExecutorLogEvent.StartupInterrupted, count: interrupted.length });
    }
    this.timer = setInterval(() => {
      try {
        this.pump();
        this.sweepLostRuns();
      } catch (error) {
        this.logger({
          event: AgentRunExecutorLogEvent.LoopFailed,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }, this.tickMs);
    this.timer.unref?.();
    this.pump();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const entry of this.active.values()) {
      entry.intent ??= AbortIntent.Stop;
      entry.controller.abort(new Error("executor stopped"));
    }
    await this.draining;
  }

  /** Background by default: validates, records the durable pending row, and returns it
   * immediately. The queue pump starts it as soon as a slot under the cap frees. */
  launch(input: AgentRunCreateInput): AgentRun {
    if (this.stopping) throw new Error("agent-run executor has been stopped");
    if (!AGENT_RUN_CAPABILITIES[input.harness]) {
      throw new Error(`unknown delegation harness: ${String(input.harness)}`);
    }
    if (!input.task.trim()) throw new Error("delegation task is required");
    if (!isAbsolute(input.cwd)) throw new Error("delegation cwd must be an absolute path");
    const timeoutSeconds = input.timeoutSeconds ?? DEFAULT_AGENT_RUN_TIMEOUT_SECONDS;
    if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > MAX_AGENT_RUN_TIMEOUT_SECONDS) {
      throw new Error(`delegation timeoutSeconds must be 1..${MAX_AGENT_RUN_TIMEOUT_SECONDS}`);
    }
    // Enforce the delegation-depth cap, not just structurally: if the delegating thread is
    // itself some run's child, this launch would sit one level deeper. A child needing a helper
    // uses its harness's native subagents, which never touch the ledger.
    const depth = this.depthFor(input.parentThreadId ?? null);
    if (depth > AGENT_RUN_MAX_DEPTH) {
      throw new Error(`delegation depth ${depth} exceeds the cap of ${AGENT_RUN_MAX_DEPTH}`);
    }
    const run = this.state.createAgentRun({
      harness: input.harness,
      task: input.task,
      cwd: input.cwd,
      parentThreadId: input.parentThreadId ?? null,
      model: input.model ?? null,
      depth,
      timeoutSeconds,
    });
    this.pump();
    return run;
  }

  /** The depth a run launched under `parentThreadId` would sit at. Depth 1 when the parent is
   * the Operator (or unattributed); one deeper when the parent thread is itself a run's child. */
  private depthFor(parentThreadId: string | null): number {
    if (!parentThreadId) return 1;
    const parentRun = this.state.agentRunByChildSession(parentThreadId);
    return (parentRun?.depth ?? 0) + 1;
  }

  /** Cancel cascades to the child process through the abort signal, then resolves with the
   * finalized row. A queued run is finalized immediately; a terminal run is returned unchanged
   * (monotonic). The abort fires synchronously before the first await, so a fire-and-forget
   * caller still propagates the cancel. */
  async cancel(id: string): Promise<AgentRun> {
    const run = this.state.agentRunById(id);
    if (!run) throw new Error(`no such agent run: ${id}`);
    const entry = this.active.get(id);
    if (entry) {
      entry.intent ??= AbortIntent.Cancel;
      entry.controller.abort(new Error("run cancelled"));
      // Bounded wait for the launcher's rejection to finalize the row.
      return this.wait(id, 5_000);
    }
    if (run.status === AgentRunStatus.Pending) {
      return this.state.finishAgentRun(id, {
        status: AgentRunStatus.Cancelled,
        resultTail: null,
        error: "cancelled before start",
      }) ?? this.state.agentRunById(id)!;
    }
    return run;
  }

  /** Resume = same child identity, new run. Requires a persisted child session id and a
   * harness whose capability record allows resumption. */
  resume(id: string): AgentRun {
    if (this.stopping) throw new Error("agent-run executor has been stopped");
    const run = this.state.agentRunById(id);
    if (!run) throw new Error(`no such agent run: ${id}`);
    if (!AGENT_RUN_RESUMABLE_STATUSES.includes(run.status)) {
      throw new Error(`agent run is not resumable from status ${run.status}`);
    }
    if (!AGENT_RUN_CAPABILITIES[run.harness]?.resume) {
      throw new Error(`harness ${run.harness} does not support resume`);
    }
    if (!run.childSessionId) {
      throw new Error("agent run has no child session identity to resume");
    }
    // Guard concurrent resumes of one child: two resume calls for the same source must not both
    // start turns on that child session. resume()/createAgentRun() are synchronous over
    // DatabaseSync, so this check-then-create is atomic in the single-process daemon — if a prior
    // resume is already pending or running for this child, return it instead of duplicating.
    const inflight = this.state.nonterminalAgentRunByChildSession(run.childSessionId);
    if (inflight) return inflight;
    const resumed = this.state.createAgentRun({
      harness: run.harness,
      task: run.task,
      cwd: run.cwd,
      parentThreadId: run.parentThreadId,
      model: run.model,
      depth: run.depth,
      timeoutSeconds: run.timeoutSeconds,
      resumeOfRunId: run.id,
      childSessionId: run.childSessionId,
      acpxRecordId: run.acpxRecordId,
    });
    this.pump();
    return resumed;
  }

  /** Bounded block until the run is terminal; returns the current row either way. */
  async wait(id: string, timeoutMs: number): Promise<AgentRun> {
    const deadline = this.now() + timeoutMs;
    for (;;) {
      const run = this.state.agentRunById(id);
      if (!run) throw new Error(`no such agent run: ${id}`);
      if (isTerminalAgentRunStatus(run.status) || this.now() >= deadline) return run;
      await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS));
    }
  }

  /** The reconciliation sweep: durable running rows with no live in-process turn and no
   * activity inside the grace window go lost. Terminal states stay monotonic. */
  sweepLostRuns(): void {
    const cutoff = new Date(this.now() - this.lostGraceMs).toISOString();
    const lost = this.state.markAgentRunsLost([...this.active.keys()], cutoff);
    if (lost.length) this.logger({ event: AgentRunExecutorLogEvent.RunsLost, runIds: lost });
  }

  activeRunIds(): string[] {
    return [...this.active.keys()];
  }

  private pump(): void {
    if (this.stopping) return;
    for (;;) {
      if (this.active.size >= this.maxConcurrent) return;
      const claimed = this.state.claimNextPendingAgentRun(this.maxConcurrent);
      if (!claimed) return;
      const work = this.execute(claimed).catch((error) => {
        this.logger({
          event: AgentRunExecutorLogEvent.LoopFailed,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      this.draining = this.draining.then(() => work, () => work);
    }
  }

  private async execute(run: AgentRun): Promise<void> {
    const controller = new AbortController();
    const entry: { controller: AbortController; intent: AbortIntent | null } = { controller, intent: null };
    this.active.set(run.id, entry);
    // OO owns the deadline: a launcher-side timeout after partial output must never read
    // as success, so the executor aborts and records the failure itself.
    const timeout = setTimeout(() => {
      entry.intent ??= AbortIntent.Timeout;
      controller.abort(new Error(`run timed out after ${run.timeoutSeconds}s`));
    }, run.timeoutSeconds * 1_000);
    timeout.unref?.();
    try {
      const result = await this.launcher({
        run,
        resumeSessionId: run.childSessionId,
        signal: controller.signal,
        onActivity: (update) => {
          this.state.recordAgentRunActivity(run.id, update);
        },
      });
      // An abort intent always wins over the launcher's own outcome — status AND reason. Launchers
      // differ on how they report an abort (the acpx bridge resolves with `cancelled`, a throwing
      // launcher rejects), so a timed-out or stopped run must be recorded with the executor's
      // intent and its own explanation, never the launcher's `cancelled`. A non-aborted turn keeps
      // the launcher's status and error.
      this.finish(run.id, {
        status: entry.intent ? this.statusForIntent(entry.intent) : result.status,
        resultTail: result.resultText ? tail(result.resultText) : null,
        error: entry.intent ? this.errorForIntent(entry.intent) : result.error,
        ...(result.childSessionId ? { childSessionId: result.childSessionId } : {}),
        ...(result.acpxRecordId ? { acpxRecordId: result.acpxRecordId } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.finish(run.id, {
        status: entry.intent ? this.statusForIntent(entry.intent) : AgentRunStatus.Failed,
        resultTail: null,
        error: entry.intent ? this.errorForIntent(entry.intent) : message,
      });
    } finally {
      clearTimeout(timeout);
      this.active.delete(run.id);
      this.pump();
    }
  }

  private statusForIntent(intent: AbortIntent): AgentRunFinalStatus {
    if (intent === AbortIntent.Cancel) return AgentRunStatus.Cancelled;
    if (intent === AbortIntent.Timeout) return AgentRunStatus.Failed;
    return AgentRunStatus.Interrupted; // Stop
  }

  /** The executor-owned explanation for an aborted run, so a timeout or daemon stop is recorded
   * with its real reason rather than the launcher's `cancelled`. */
  private errorForIntent(intent: AbortIntent): string {
    if (intent === AbortIntent.Cancel) return "run cancelled";
    if (intent === AbortIntent.Timeout) return "run timed out";
    return "daemon stopped during run"; // Stop
  }

  private finish(runId: string, outcome: AgentRunOutcome): void {
    const finished = this.state.finishAgentRun(runId, outcome);
    if (finished) {
      this.logger({
        event: AgentRunExecutorLogEvent.RunFinished,
        runId,
        status: finished.status,
        error: finished.error,
      });
    }
  }
}
