import { isAbsolute } from "node:path";
import {
  AGENT_RUN_CAPABILITIES,
  AGENT_RUN_MAX_DEPTH,
  AGENT_RUN_MAX_CONCURRENT,
  AgentRunStatus,
  DEFAULT_AGENT_RUN_TIMEOUT_SECONDS,
  MAX_AGENT_RUN_TIMEOUT_SECONDS,
  agentRunTurnIntent,
  isAgentRunEffort,
  isTerminalAgentRunStatus,
  validateAgentRunResumeTask,
  type AgentRun,
  type AgentRunCreateInput,
  type AgentRunFinalStatus,
  type AgentRunLaunchRequest,
  type AgentRunLaunchResult,
  type AgentRunOutcome,
} from "@owner-operator/core";
import type { State } from "../state/state";
import { continuationsOf } from "./continuation";
import { resolveAgentRunLaunch } from "./launch-config";
import { interruptedFollowUps, nestedCompletionTask, owedContinuations } from "./nested-planner";

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
    this.maxConcurrent = options.maxConcurrent ?? AGENT_RUN_MAX_CONCURRENT;
    if (!Number.isSafeInteger(this.maxConcurrent) || this.maxConcurrent < 0
      || this.maxConcurrent > AGENT_RUN_MAX_CONCURRENT) {
      throw new Error(`maxConcurrent must be an integer in 0..${AGENT_RUN_MAX_CONCURRENT}`);
    }
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
    for (const run of interruptedFollowUps(this.state.listAgentRuns())) {
      try {
        this.retry(run.id);
      } catch (error) {
        this.logger({ event: AgentRunExecutorLogEvent.LoopFailed,
          error: `automatic retry of interrupted follow-up ${run.id}: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
    this.continueOwedParents();
    this.timer = setInterval(() => {
      try {
        this.sweepLostRuns();
        this.pump();
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
    if (input.effort != null && !isAgentRunEffort(input.effort)) {
      throw new Error(`unknown delegation effort: ${String(input.effort)}`);
    }
    const timeoutSeconds = input.timeoutSeconds ?? DEFAULT_AGENT_RUN_TIMEOUT_SECONDS;
    if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > MAX_AGENT_RUN_TIMEOUT_SECONDS) {
      throw new Error(`delegation timeoutSeconds must be 1..${MAX_AGENT_RUN_TIMEOUT_SECONDS}`);
    }
    const depth = this.depthFor(input.parentThreadId ?? null);
    if (depth > AGENT_RUN_MAX_DEPTH) {
      throw new Error(`delegation depth ${depth} exceeds the cap of ${AGENT_RUN_MAX_DEPTH}`);
    }
    const launch = resolveAgentRunLaunch(input.harness, {
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.effort !== undefined ? { effort: input.effort } : {}),
      ...(input.onMissingBaseline ? { onMissingBaseline: input.onMissingBaseline } : {}),
    });
    const run = this.state.createAgentRun({
      harness: input.harness,
      task: input.task,
      cwd: input.cwd,
      parentThreadId: input.parentThreadId ?? null,
      model: launch.model,
      effort: launch.effort,
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
      const finished = this.state.finishAgentRun(id, {
        status: AgentRunStatus.Cancelled,
        resultTail: null,
        error: "cancelled before start",
      }) ?? this.state.agentRunById(id)!;
      this.continueOwedParents();
      this.pump();
      return finished;
    }
    return run;
  }

  retry(id: string): AgentRun {
    if (this.stopping) throw new Error("agent-run executor has been stopped");
    const run = this.state.agentRunById(id);
    if (!run) throw new Error(`no such agent run: ${id}`);
    // Synchronous over DatabaseSync, so the verdict and the row it licenses are atomic.
    const verdict = continuationsOf(this.state.listAgentRuns()).retry(run);
    if (verdict.kind === "in-flight") return verdict.successor;
    if (verdict.kind === "refused") throw new Error(verdict.reason);
    const retried = this.state.createAgentRun(verdict.successor);
    this.pump();
    return retried;
  }

  /** Resume = one required new task after a terminal run, using the same child conversation. */
  resume(id: string, task: string): AgentRun {
    const run = this.state.agentRunById(id);
    if (!run) throw new Error(`no such agent run: ${id}`);
    const pending = run.promptSubmitted ? [] : run.completionRunIds.map((childId) => {
      const child = this.state.agentRunById(childId);
      if (!child) throw new Error(`undelivered child run ${childId} is missing`);
      return child;
    });
    const corrected = validateAgentRunResumeTask(task);
    return this.resumeWithCompletions(id, pending.length
      ? corrected + "\n\nPending child completion evidence from the earlier unsubmitted turn:\n"
        + nestedCompletionTask(run, pending)
      : corrected, pending.map((child) => child.id));
  }

  private resumeWithCompletions(id: string, task: string, completionRunIds: readonly string[]): AgentRun {
    if (this.stopping) throw new Error("agent-run executor has been stopped");
    const run = this.state.agentRunById(id);
    if (!run) throw new Error(`no such agent run: ${id}`);
    const followUpTask = validateAgentRunResumeTask(task);
    const verdict = continuationsOf(this.state.listAgentRuns()).resume(run);
    if (verdict.kind === "refused") throw new Error(verdict.reason);
    const resumed = this.state.createAgentRun({ ...verdict.successor, task: followUpTask, completionRunIds });
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
    if (lost.length) this.continueOwedParents();
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

  private continueOwedParents(): void {
    for (const { parent, children } of owedContinuations(this.state.listAgentRuns())) {
      try {
        this.resumeWithCompletions(parent.id, nestedCompletionTask(parent, children), children.map((child) => child.id));
      } catch (error) {
        this.logger({ event: AgentRunExecutorLogEvent.LoopFailed,
          error: `automatic continuation of ${parent.id}: ${error instanceof Error ? error.message : String(error)}` });
      }
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
      const retriedRun = run.retryOfRunId ? this.state.agentRunById(run.retryOfRunId) : undefined;
      const resumedRun = run.resumeOfRunId ? this.state.agentRunById(run.resumeOfRunId) : undefined;
      const turnIntent = agentRunTurnIntent(run, retriedRun, resumedRun);
      const result = await this.launcher({
        run,
        turnIntent,
        signal: controller.signal,
        onActivity: (update) => {
          this.state.recordAgentRunActivity(run.id, update);
        },
        onEvent: (event) => {
          this.state.appendAgentRunEvent(run.id, event);
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
      if (!this.stopping) this.continueOwedParents();
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
