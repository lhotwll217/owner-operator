import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { spawn } from "node:child_process";
import {
  AgentToolId,
  ScheduleKind,
  DomainEventKind,
  ScheduleRunStatus,
  ScheduleRunTrigger,
  ScheduledPayloadKind,
  type ScheduleCreateInput,
  type ScheduleDefinition,
  type ScheduleExecutionResult,
  type ScheduleRun,
  type ScheduleTriggerContext,
  type ScheduledCommandPayload,
  type ScheduledPromptPayload,
} from "@owner-operator/core";
import type { State } from "../state/state";
import { computeNextRunAt, countMissedOccurrences } from "./schedule";

const OUTPUT_TAIL_BYTES = 32 * 1024;
const TERMINATION_GRACE_MS = 1_000;

export interface CommandExecutionRequest {
  argv: readonly [string, ...string[]];
  cwd: string;
  signal: AbortSignal;
}

export interface PromptExecutionRequest {
  payload: ScheduledPromptPayload;
  cwd: string;
  schedule: ScheduleDefinition;
  runId: string;
  signal: AbortSignal;
  triggerContext?: ScheduleTriggerContext;
}

export enum SchedulerLogEvent {
  RunFinished = "run-finished",
  StartupInterrupted = "startup-interrupted",
}

export type SchedulerLogRecord =
  | {
      event: SchedulerLogEvent.RunFinished;
      scheduleId: string;
      runId: string;
      status: ScheduleRunStatus;
      error: string | null;
    }
  | {
      event: SchedulerLogEvent.StartupInterrupted;
      count: number;
    };

export interface SchedulerOptions {
  now?: () => number;
  tickMs?: number;
  commandRunner?: (request: CommandExecutionRequest) => Promise<ScheduleExecutionResult>;
  promptRunner?: (request: PromptExecutionRequest) => Promise<ScheduleExecutionResult>;
  logger?: (record: SchedulerLogRecord) => void;
}

const tail = (value: string): string => {
  const bytes = Buffer.from(value);
  if (bytes.length <= OUTPUT_TAIL_BYTES) return value;
  return `[truncated to last ${OUTPUT_TAIL_BYTES} bytes]\n${bytes.subarray(bytes.length - OUTPUT_TAIL_BYTES).toString()}`;
};

async function runCommand({ argv, cwd, signal }: CommandExecutionRequest): Promise<ScheduleExecutionResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout = tail(stdout + String(chunk)); });
    child.stderr.on("data", (chunk) => { stderr = tail(stderr + String(chunk)); });
    child.once("error", reject);
    let forceKill: NodeJS.Timeout | null = null;
    child.once("close", (code, killedBy) => {
      if (forceKill) clearTimeout(forceKill);
      resolve({ exitCode: code ?? (killedBy ? 1 : 0), stdout, stderr });
    });
    const abort = (): void => {
      child.kill("SIGTERM");
      forceKill = setTimeout(() => child.kill("SIGKILL"), TERMINATION_GRACE_MS);
      forceKill.unref?.();
    };
    signal.addEventListener("abort", abort, { once: true });
    child.once("close", () => signal.removeEventListener("abort", abort));
  });
}

/** Canonical in-process scheduler. SQLite owns jobs/runs; this class owns time and execution. */
export class Scheduler {
  private readonly now: () => number;
  private readonly commandRunner: SchedulerOptions["commandRunner"];
  private readonly promptRunner?: SchedulerOptions["promptRunner"];
  private readonly tickMs: number;
  private readonly logger: (record: SchedulerLogRecord) => void;
  private readonly running = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;
  private eventFlush: NodeJS.Immediate | null = null;
  private readonly pendingNeedsYou = new Map<string, string>();
  private executionQueue: Promise<void> = Promise.resolve();

  constructor(private readonly state: State, options: SchedulerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.tickMs = options.tickMs ?? 1_000;
    this.commandRunner = options.commandRunner ?? runCommand;
    this.promptRunner = options.promptRunner;
    this.logger = options.logger ?? (() => undefined);
  }

  createSchedule(input: ScheduleCreateInput): ScheduleDefinition {
    this.validateSchedule(input);
    const nowMs = this.now();
    const now = new Date(nowMs).toISOString();
    const nextRunAt = input.enabled
      ? input.trigger.kind === ScheduleKind.At
        ? new Date(Date.parse(input.trigger.at)).toISOString()
        : computeNextRunAt(input.trigger, nowMs)
      : null;
    const schedule: ScheduleDefinition = {
      id: randomUUID(), ...input, name: input.name.trim(), revision: 1,
      createdAt: now, updatedAt: now, nextRunAt,
    };
    return this.state.saveSchedule(schedule);
  }

  updateSchedule(id: string, input: ScheduleCreateInput): ScheduleDefinition {
    this.validateSchedule(input);
    const existing = this.state.scheduleById(id);
    if (!existing) throw new Error(`no such schedule: ${id}`);
    const nowMs = this.now();
    const schedule: ScheduleDefinition = {
      id,
      ...input,
      name: input.name.trim(),
      revision: existing.revision + 1,
      createdAt: existing.createdAt,
      updatedAt: new Date(nowMs).toISOString(),
      nextRunAt: input.enabled
        ? input.trigger.kind === ScheduleKind.At
          ? new Date(Date.parse(input.trigger.at)).toISOString()
          : computeNextRunAt(input.trigger, nowMs)
        : null,
    };
    return this.state.saveSchedule(schedule);
  }

  private validateSchedule(input: ScheduleCreateInput): void {
    if (!input.name.trim()) throw new Error("schedule name is required");
    if (!isAbsolute(input.cwd)) throw new Error("schedule cwd must be an absolute path");
    if (!Number.isSafeInteger(input.timeoutSeconds) || input.timeoutSeconds < 1) {
      throw new Error("schedule timeoutSeconds must be a positive integer");
    }
    if (!Object.values(ScheduleKind).includes(input.trigger.kind)) throw new Error("invalid schedule kind");
    if (input.trigger.kind === ScheduleKind.At && !Number.isFinite(Date.parse(input.trigger.at))) {
      throw new Error("invalid at schedule");
    }
    if (input.payload.kind === ScheduledPayloadKind.Command) {
      if (!input.payload.argv.length || input.payload.argv.some((part) => typeof part !== "string")) {
        throw new Error("command argv must contain string arguments and an executable");
      }
    } else if (input.payload.kind === ScheduledPayloadKind.Prompt) {
      if (!input.payload.prompt.trim()) throw new Error("scheduled prompt is required");
      const knownTools = new Set<string>(Object.values(AgentToolId));
      if (input.payload.toolsAllow?.some((tool) => !knownTools.has(tool))) {
        throw new Error("scheduled prompt contains an unknown tool id");
      }
    } else {
      throw new Error("invalid scheduled payload kind");
    }
    computeNextRunAt(input.trigger, this.now());
  }

  listSchedules(): ScheduleDefinition[] {
    return this.state.listSchedules();
  }

  deleteSchedule(id: string): boolean {
    return this.state.deleteSchedule(id);
  }

  start(): void {
    if (this.timer) return;
    const interrupted = this.state.markRunningScheduleRunsInterrupted("daemon restarted during execution");
    if (interrupted) this.logger({ event: SchedulerLogEvent.StartupInterrupted, count: interrupted });
    this.unsubscribe = this.state.bus.subscribe((event) => {
      if (
        event.kind !== DomainEventKind.ThreadChanged || event.state !== "needs-you" ||
        !event.lastMessageAt || !event.needsEnrichment
      ) return;
      this.pendingNeedsYou.set(event.threadId, event.lastMessageAt);
      this.scheduleEventFlush();
    });
    for (const change of this.state.listNeedsYouMessageVersions()) {
      this.pendingNeedsYou.set(change.threadId, change.lastMessageAt);
    }
    this.scheduleEventFlush();
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.tickMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.eventFlush) clearImmediate(this.eventFlush);
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.eventFlush = null;
    this.timer = null;
  }

  async tick(): Promise<void> {
    const due = this.state.listDueSchedules(new Date(this.now()).toISOString());
    for (const schedule of due) {
      if (this.running.has(schedule.id)) continue;
      const nowMs = this.now();
      const scheduledMs = schedule.nextRunAt ? Date.parse(schedule.nextRunAt) : nowMs;
      const missedOccurrences = countMissedOccurrences(schedule.trigger, scheduledMs, nowMs);
      const context = {
        scheduledFor: schedule.nextRunAt,
        startedAfterMs: Math.max(0, nowMs - scheduledMs),
        missedOccurrences,
      };
      await this.enqueue(() => this.execute(
        schedule, ScheduleRunTrigger.Scheduled, schedule.nextRunAt, context,
      ));
      const next = computeNextRunAt(schedule.trigger, this.now());
      const enabled = schedule.trigger.kind !== ScheduleKind.At && schedule.enabled;
      this.state.updateScheduleNextRun(schedule.id, next, enabled, schedule.revision);
    }
  }

  async runNow(id: string): Promise<ScheduleRun> {
    const schedule = this.state.scheduleById(id);
    if (!schedule) throw new Error(`no such schedule: ${id}`);
    if (this.running.has(id)) throw new Error(`schedule already running: ${id}`);
    return await this.enqueue(() => this.execute(schedule, ScheduleRunTrigger.Manual, null));
  }

  private async execute(
    schedule: ScheduleDefinition,
    trigger: ScheduleRunTrigger,
    scheduledFor: string | null,
    triggerContext?: ScheduleTriggerContext,
    existingRun?: ScheduleRun,
  ): Promise<ScheduleRun> {
    if (this.running.has(schedule.id)) throw new Error(`schedule already running: ${schedule.id}`);
    this.running.add(schedule.id);
    const run = existingRun ?? this.state.createScheduleRun(schedule, trigger, scheduledFor, triggerContext);
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("schedule timed out"));
    }, schedule.timeoutSeconds * 1_000);
    timeout.unref?.();
    try {
      if (!existsSync(schedule.cwd)) throw new Error(`schedule cwd no longer exists: ${schedule.cwd}`);
      const work = schedule.payload.kind === ScheduledPayloadKind.Command
        ? this.commandRunner!({ argv: (schedule.payload as ScheduledCommandPayload).argv, cwd: schedule.cwd, signal: controller.signal })
        : this.runPrompt(schedule.payload, schedule, run.id, controller.signal, triggerContext);
      const result = await work;
      if (timedOut) throw controller.signal.reason ?? new Error("schedule timed out");
      const status = result.exitCode === 0 ? ScheduleRunStatus.Completed : ScheduleRunStatus.Failed;
      const finished = this.state.finishScheduleRun(run.id, schedule.id, {
        status,
        exitCode: result.exitCode,
        stdoutTail: tail(result.stdout),
        stderrTail: tail(result.stderr),
        error: result.exitCode === 0 ? null : `process exited ${result.exitCode}`,
        transcriptId: result.transcriptId ?? null,
      });
      this.logRun(finished);
      return finished;
    } catch (error) {
      const finished = this.state.finishScheduleRun(run.id, schedule.id, {
        status: ScheduleRunStatus.Failed,
        exitCode: null,
        stdoutTail: null,
        stderrTail: null,
        error: error instanceof Error ? error.message : String(error),
        transcriptId: null,
      });
      this.logRun(finished);
      return finished;
    } finally {
      clearTimeout(timeout);
      this.running.delete(schedule.id);
    }
  }

  private runPrompt(
    payload: ScheduledPromptPayload,
    schedule: ScheduleDefinition,
    runId: string,
    signal: AbortSignal,
    triggerContext?: ScheduleTriggerContext,
  ): Promise<ScheduleExecutionResult> {
    if (!this.promptRunner) throw new Error("scheduled prompt runner is not configured");
    return this.promptRunner({ payload, cwd: schedule.cwd, schedule, runId, signal, triggerContext });
  }

  private logRun(run: ScheduleRun): void {
    this.logger({
      event: SchedulerLogEvent.RunFinished,
      scheduleId: run.scheduleId,
      runId: run.id,
      status: run.status,
      error: run.error,
    });
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.executionQueue.then(work, work);
    this.executionQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private scheduleEventFlush(): void {
    if (this.eventFlush) return;
    this.eventFlush = setImmediate(() => {
      this.eventFlush = null;
      void this.flushNeedsYou();
    });
    this.eventFlush.unref?.();
  }

  private async flushNeedsYou(): Promise<void> {
    const changes = [...this.pendingNeedsYou].map(([threadId, lastMessageAt]) => ({ threadId, lastMessageAt }));
    this.pendingNeedsYou.clear();
    if (!changes.length) return;
    for (const schedule of this.state.listSchedules()) {
      if (!schedule.enabled || schedule.trigger.kind !== ScheduleKind.NeedsYou) continue;
      const claimed = this.state.claimNeedsYouScheduleRun(schedule, changes);
      if (!claimed) continue;
      const context = { threadIds: claimed.threadIds, observedThrough: claimed.observedThrough };
      await this.enqueue(() => this.execute(
        schedule,
        ScheduleRunTrigger.NeedsYou,
        null,
        context,
        claimed.run,
      ));
    }
  }
}
