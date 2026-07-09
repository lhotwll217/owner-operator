import {
  DomainEventKind,
  ScheduleRunStatus,
  loadActiveWindow,
  parseWindowMs,
  resolveState,
  type DomainEvent,
  type ScheduleDefinition,
  type ScheduleRun,
  type ScheduleRunTrigger,
  type ScanRow,
  type EnrichmentCandidate,
  type ScheduleTriggerContext,
  type ThreadDetails,
} from "@owner-operator/core";
import { randomUUID } from "node:crypto";
import { ThreadDb, type SessionStateRow } from "./database";
import { InMemoryEventBus } from "./event-bus";

export interface StateOptions {
  bus?: InMemoryEventBus;
  now?: () => string;
  activeWindow?: string;
}

export interface MarkThreadsDoneResult {
  marked: SessionStateRow[];
  missingIds: string[];
}

/** The daemon's sole durable-state seam. All writes commit before events are published. */
export class State {
  readonly bus: InMemoryEventBus;
  private readonly db: ThreadDb;
  private readonly now: () => string;
  private readonly activeWindow: string;

  constructor(dbPath?: string, options: StateOptions = {}) {
    this.bus = options.bus ?? new InMemoryEventBus();
    this.now = options.now ?? (() => new Date().toISOString());
    this.activeWindow = options.activeWindow ?? loadActiveWindow();
    this.db = new ThreadDb(dbPath, { now: this.now });
  }

  recordObservation(row: ScanRow): void {
    const previous = this.db.resolutionRow(row.id);
    const state = resolveState(
      previous?.lastMessageAt
        ? { state: previous.state, lastMessageAt: previous.lastMessageAt }
        : undefined,
      row,
    );
    const changedMessage = row.lastMessageAt !== previous?.lastMessageAt;
    const result = this.db.recordScan({
      id: row.id,
      source: row.source,
      repo: row.repo,
      project: row.project,
      app: row.app,
      createdAt: row.createdAt,
      lastActiveAt: row.lastMessageAt,
      lastMessageAt: row.lastMessageAt,
      rawTopic: row.topic,
      state,
      diffAdded: row.diffAdded,
      diffDeleted: row.diffDeleted,
    });

    if (result.added || result.stateChanged || changedMessage) {
      this.publish({
        kind: DomainEventKind.ThreadChanged,
        threadId: row.id,
        state,
        lastMessageAt: row.lastMessageAt,
        needsEnrichment:
          state === "needs-you" && row.lastMessageAt !== previous?.enrichedThroughMessageAt,
      });
    }
  }

  recordPoll(rows: readonly ScanRow[]): void {
    for (const row of rows) this.recordObservation(row);
  }

  listSessionState(options: { activeSince?: string } = {}): SessionStateRow[] {
    return this.db.listSessionState(options);
  }

  /** Current client projection. SQLite retains history; quiet rows age out of this view. */
  listCurrentSessionState(): SessionStateRow[] {
    const nowMs = Date.parse(this.now());
    const cutoffMs = parseWindowMs(this.activeWindow, nowMs);
    return this.db.listSessionState({
      activeSince: new Date(cutoffMs ?? nowMs - 24 * 60 * 60 * 1_000).toISOString(),
    });
  }

  listEnrichmentCandidates(): EnrichmentCandidate[] {
    return this.db.listEnrichmentCandidates();
  }

  appendEnrichment(threadId: string, details: ThreadDetails, throughMessageAt: string): boolean {
    const applied = this.db.appendModelDetailsIfCurrent(threadId, details, throughMessageAt) !== null;
    if (!applied) return false;
    const current = this.db.resolutionRow(threadId);
    if (current) {
      this.publish({
        kind: DomainEventKind.ThreadChanged,
        threadId,
        state: current.state,
        lastMessageAt: current.lastMessageAt,
        needsEnrichment: false,
      });
    }
    return true;
  }

  markThreadsDone(ids: readonly string[]): MarkThreadsDoneResult {
    const unique = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
    const before = new Map(this.db.listSessionState().map((row) => [row.id, row]));
    const result = this.db.markDone(unique);
    for (const id of result.markedIds) {
      const previous = before.get(id);
      this.publish({
        kind: DomainEventKind.ThreadChanged,
        threadId: id,
        state: "done",
        lastMessageAt: previous?.lastMessageAt ?? null,
        needsEnrichment: false,
      });
    }
    return {
      marked: result.markedIds.flatMap((id) => before.get(id) ? [{ ...before.get(id)!, state: "done" as const }] : []),
      missingIds: result.missingIds,
    };
  }

  renameThread(threadId: string, title: string): boolean {
    const changed = this.db.setOwnerTitle(threadId, title);
    if (!changed) return false;
    const current = this.db.resolutionRow(threadId);
    if (current) {
      this.publish({
        kind: DomainEventKind.ThreadChanged,
        threadId,
        state: current.state,
        lastMessageAt: current.lastMessageAt,
        needsEnrichment: false,
      });
    }
    return true;
  }

  saveSchedule(schedule: ScheduleDefinition): ScheduleDefinition {
    this.db.saveSchedule(schedule);
    this.publish({ kind: DomainEventKind.ScheduleChanged, scheduleId: schedule.id });
    return schedule;
  }

  listSchedules(): ScheduleDefinition[] {
    return this.db.listSchedules();
  }

  scheduleById(id: string): ScheduleDefinition | undefined {
    return this.db.scheduleById(id);
  }

  listDueSchedules(nowIso: string): ScheduleDefinition[] {
    return this.db.dueSchedules(nowIso);
  }

  deleteSchedule(id: string): boolean {
    const deleted = this.db.softDeleteSchedule(id);
    if (deleted) this.publish({ kind: DomainEventKind.ScheduleChanged, scheduleId: id });
    return deleted;
  }

  updateScheduleNextRun(
    id: string,
    nextRunAt: string | null,
    enabled: boolean,
    expectedRevision: number,
  ): boolean {
    const changed = this.db.updateScheduleNextRun(id, nextRunAt, enabled, expectedRevision);
    if (changed) this.publish({ kind: DomainEventKind.ScheduleChanged, scheduleId: id });
    return changed;
  }

  createScheduleRun(
    schedule: ScheduleDefinition,
    trigger: ScheduleRunTrigger,
    scheduledFor: string | null,
    triggerContext?: ScheduleTriggerContext,
  ): ScheduleRun {
    const run = this.db.createScheduleRun({
      id: randomUUID(), schedule, trigger, scheduledFor, triggerContext,
    });
    this.publish({
      kind: DomainEventKind.ScheduleRunChanged,
      scheduleId: schedule.id,
      runId: run.id,
      status: run.status,
    });
    return run;
  }

  finishScheduleRun(id: string, scheduleId: string, outcome: {
    status: ScheduleRunStatus.Completed | ScheduleRunStatus.Failed;
    exitCode: number | null;
    stdoutTail: string | null;
    stderrTail: string | null;
    error: string | null;
    transcriptId: string | null;
  }): ScheduleRun {
    const run = this.db.finishScheduleRun(id, outcome);
    this.publish({
      kind: DomainEventKind.ScheduleRunChanged,
      scheduleId,
      runId: id,
      status: run.status,
    });
    return run;
  }

  markRunningScheduleRunsInterrupted(reason: string): number {
    return this.db.markRunningScheduleRunsInterrupted(reason);
  }

  listScheduleRuns(scheduleId?: string): ScheduleRun[] {
    return this.db.listScheduleRuns(scheduleId);
  }

  listNeedsYouMessageVersions(): Array<{ threadId: string; lastMessageAt: string }> {
    return this.db.listNeedsYouMessageVersions();
  }

  claimNeedsYouScheduleRun(
    schedule: ScheduleDefinition,
    changes: readonly { threadId: string; lastMessageAt: string }[],
  ): { run: ScheduleRun; threadIds: string[]; observedThrough: string } | null {
    const claimed = this.db.claimNeedsYouScheduleRun({ id: randomUUID(), schedule, changes });
    if (claimed) {
      this.publish({
        kind: DomainEventKind.ScheduleRunChanged,
        scheduleId: schedule.id,
        runId: claimed.run.id,
        status: claimed.run.status,
      });
    }
    return claimed;
  }

  close(): void {
    this.db.close();
  }

  private publish(event: DomainEvent): void {
    this.bus.publish(event);
  }
}
