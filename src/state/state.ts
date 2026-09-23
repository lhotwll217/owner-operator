import {
  AgentRunStatus,
  DomainEventKind,
  ScheduleRunStatus,
  isBlacklisted,
  loadBlacklist,
  loadActiveWindow,
  loadAgentRunEventLogMaxBytes,
  parseWindowMs,
  resolveState,
  type AgentRun,
  type AgentRunActivityUpdate,
  type AgentRunOutcome,
  type AgentRunStreamEvent,
  type DomainEvent,
  type ScheduleDefinition,
  type ScheduleRun,
  type ScheduleRunTrigger,
  type ScanRow,
  type EnrichmentCandidate,
  type ScheduleTriggerContext,
  type ThreadEnrichment,
  type Blacklist,
  type MarkThreadsDoneResult,
  type RegisteredWorktree,
} from "@owner-operator/core";
import { randomUUID } from "node:crypto";
import { ThreadDb, type AgentRunInsert, type AgentRunLogEntry, type SessionStateRow } from "./database";
import { InMemoryEventBus } from "./event-bus";
import { ownerOperatorHome } from "../shared/paths";

export interface StateOptions {
  bus?: InMemoryEventBus;
  now?: () => string;
  activeWindow?: string;
  /** Per-run event-log retention; defaults to the owner's `agentRunEventLogMaxBytes` setting. */
  eventLogMaxBytes?: number;
}

/** The daemon's sole durable-state seam. All writes commit before events are published. */
export class State {
  readonly bus: InMemoryEventBus;
  private readonly runLogListeners = new Set<(runId: string) => void>();
  private readonly db: ThreadDb;
  private readonly now: () => string;
  private readonly activeWindow: string;
  private readonly blacklist: () => Blacklist;

  constructor(dbPath?: string, options: StateOptions = {}) {
    this.bus = options.bus ?? new InMemoryEventBus();
    this.now = options.now ?? (() => new Date().toISOString());
    this.activeWindow = options.activeWindow ?? loadActiveWindow(ownerOperatorHome());
    this.blacklist = () => loadBlacklist(ownerOperatorHome());
    const eventLogMaxBytes = options.eventLogMaxBytes ?? loadAgentRunEventLogMaxBytes(ownerOperatorHome(), (value) => {
      process.stderr.write(`${JSON.stringify({
        component: "state",
        event: "setting-rejected",
        setting: "agentRunEventLogMaxBytes",
        value,
        reason: "must be a positive integer byte count; using the default",
      })}\n`);
    });
    this.db = new ThreadDb(dbPath, { now: this.now, eventLogMaxBytes });
    this.db.purgeBlacklisted(this.blacklist());
  }

  recordObservation(row: ScanRow): void {
    if (isBlacklisted(this.blacklist(), { cwd: row.project, repo: row.repo })) return;
    const previous = this.db.resolutionRow(row.id);
    const state = !row.working && previous?.lastMessageAt === row.lastMessageAt &&
      previous.enrichedThroughMessageAt === row.lastMessageAt && !previous.enrichedWhileWorking && previous.state !== "working"
      ? previous.state
      : resolveState(
      previous?.lastMessageAt
        ? { state: previous.state, lastMessageAt: previous.lastMessageAt }
        : undefined,
      row,
    );
    const changedMessage = row.lastMessageAt > (previous?.lastMessageAt ?? "");
    const result = this.db.recordScan({
      id: row.id,
      source: row.source,
      repo: row.repo,
      project: row.project,
      app: row.app,
      transcriptPath: row.transcriptPath,
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
          state !== "done" && row.lastMessageAt !== previous?.enrichedThroughMessageAt,
      });
    }
  }

  recordPoll(rows: readonly ScanRow[]): void {
    this.db.purgeBlacklisted(this.blacklist());
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
    const visible = new Set(this.listCurrentSessionState().map((row) => row.id));
    return this.db.listEnrichmentCandidates().filter((row) => visible.has(row.id));
  }

  requestEnrichment(requests: readonly { id: string; lastMessageAt: string }[]): string[] {
    const visible = new Set(this.listCurrentSessionState().map((row) => row.id));
    const queuedIds = this.db.requestEnrichment(requests.filter((row) => visible.has(row.id)));
    for (const threadId of queuedIds) {
      const current = this.db.resolutionRow(threadId)!;
      this.publish({
        kind: DomainEventKind.ThreadChanged,
        threadId,
        state: current.state,
        lastMessageAt: current.lastMessageAt,
        needsEnrichment: true,
      });
    }
    return queuedIds;
  }

  /** The current revision of a thread's status, including the position it was written from. */
  latestDetails(threadId: string) {
    return this.db.latestDetails(threadId);
  }

  statusSummaryHistory(threadId: string, limit: number) {
    return this.db.statusSummaryHistory(threadId, limit);
  }

  appendEnrichment(
    threadId: string,
    details: ThreadEnrichment,
    throughMessageAt: string,
    children: EnrichmentCandidate["children"] = [],
  ): boolean {
    const applied = this.db.appendModelDetailsIfFresh(threadId, details, throughMessageAt, children) !== null;
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
      alreadyDoneIds: result.alreadyDoneIds,
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

  claimScheduledRun(
    schedule: ScheduleDefinition,
    scheduledFor: string,
    nextRunAt: string | null,
    enabled: boolean,
    triggerContext: ScheduleTriggerContext,
  ): ScheduleRun | null {
    const run = this.db.claimScheduledRun({
      id: randomUUID(), schedule, scheduledFor, nextRunAt, enabled, triggerContext,
    });
    if (!run) return null;
    this.publish({ kind: DomainEventKind.ScheduleChanged, scheduleId: schedule.id });
    this.publish({
      kind: DomainEventKind.ScheduleRunChanged,
      scheduleId: schedule.id,
      runId: run.id,
      status: run.status,
    });
    return run;
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
    status: ScheduleRunStatus.Completed | ScheduleRunStatus.Failed | ScheduleRunStatus.Interrupted;
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

  createAgentRun(insert: Omit<AgentRunInsert, "id">): AgentRun {
    const run = this.db.createAgentRun({ ...insert, id: randomUUID() });
    this.publishAgentRun(run);
    return run;
  }

  claimNextPendingAgentRun(maxRunning: number): AgentRun | null {
    const run = this.db.claimNextPendingAgentRun(maxRunning);
    if (run) this.publishAgentRun(run);
    return run;
  }

  recordAgentRunActivity(id: string, update: AgentRunActivityUpdate): AgentRun | null {
    const run = this.db.recordAgentRunActivity(id, update);
    if (run) this.publishAgentRun(run);
    return run;
  }

  finishAgentRun(id: string, outcome: AgentRunOutcome): AgentRun | null {
    const run = this.db.finishAgentRun(id, outcome);
    if (run) {
      this.publishAgentRun(run);
      this.notifyRunLog(id);
    }
    return run;
  }

  /** Persist one child stream event of a running run, then wake its log tailers. */
  appendAgentRunEvent(id: string, event: AgentRunStreamEvent): number | null {
    const seq = this.db.appendAgentRunEvent(id, event);
    if (seq !== null) this.notifyRunLog(id);
    return seq;
  }

  agentRunEvents(id: string, afterSeq = 0): AgentRunLogEntry[] {
    return this.db.agentRunEvents(id, afterSeq);
  }

  iterateAgentRunEvents(id: string, afterSeq = 0): Iterable<AgentRunLogEntry> {
    return this.db.iterateAgentRunEvents(id, afterSeq);
  }

  agentRunLastSeq(id: string): number | null {
    return this.db.agentRunLastSeq(id);
  }

  /** Process-local wake-up for run-log tailers, separate from the domain bus so the Gateway's
   * invalidation stream never carries per-event traffic. SQLite remains the log's truth. */
  subscribeAgentRunLog(listener: (runId: string) => void): () => void {
    this.runLogListeners.add(listener);
    return () => this.runLogListeners.delete(listener);
  }

  private notifyRunLog(runId: string): void {
    for (const listener of this.runLogListeners) {
      queueMicrotask(() => {
        try { listener(runId); } catch { /* one tailer cannot fail the write or its peers */ }
      });
    }
  }

  markRunningAgentRunsInterrupted(reason: string): string[] {
    const ids = this.db.markRunningAgentRunsInterrupted(reason);
    for (const id of ids) {
      this.publish({ kind: DomainEventKind.AgentRunChanged, runId: id, status: AgentRunStatus.Interrupted });
      this.notifyRunLog(id);
    }
    return ids;
  }

  markAgentRunsLost(liveRunIds: readonly string[], activityCutoffIso: string): string[] {
    const ids = this.db.markAgentRunsLost(liveRunIds, activityCutoffIso);
    for (const id of ids) {
      this.publish({ kind: DomainEventKind.AgentRunChanged, runId: id, status: AgentRunStatus.Lost });
      this.notifyRunLog(id);
    }
    return ids;
  }

  agentRunById(id: string): AgentRun | undefined {
    return this.db.agentRunById(id);
  }

  agentRunByChildSession(childSessionId: string): AgentRun | undefined {
    return this.db.agentRunByChildSession(childSessionId);
  }

  nonterminalAgentRunByChildSession(childSessionId: string): AgentRun | undefined {
    return this.db.nonterminalAgentRunByChildSession(childSessionId);
  }

  listAgentRuns(filter: { parentThreadId?: string } = {}): AgentRun[] {
    return this.db.listAgentRuns(filter);
  }

  registerAndSelectWorktree(
    threadId: string,
    worktree: Pick<RegisteredWorktree, "repository" | "path" | "gitCommonDir">,
  ): RegisteredWorktree {
    const registered = this.db.registerAndSelectWorktree(threadId, {
      id: randomUUID(),
      ...worktree,
      createdByThreadId: threadId,
      createdAt: this.now(),
    }, this.now());
    this.publish({
      kind: DomainEventKind.WorktreeChanged,
      threadId,
      worktreeId: registered.id,
    });
    return registered;
  }

  selectWorktree(threadId: string, worktreeId: string): RegisteredWorktree {
    const selected = this.db.selectWorktree(threadId, worktreeId, this.now());
    this.publish({ kind: DomainEventKind.WorktreeChanged, threadId, worktreeId });
    return selected;
  }

  worktreeById(id: string): RegisteredWorktree | undefined {
    return this.db.worktreeById(id);
  }

  selectedWorktree(threadId: string): RegisteredWorktree | undefined {
    return this.db.selectedWorktree(threadId);
  }

  listWorktrees(repository?: string): RegisteredWorktree[] {
    return this.db.listWorktrees(repository);
  }

  close(): void {
    this.db.close();
  }

  private publishAgentRun(run: AgentRun): void {
    this.publish({ kind: DomainEventKind.AgentRunChanged, runId: run.id, status: run.status });
  }

  private publish(event: DomainEvent): void {
    this.bus.publish(event);
  }
}
