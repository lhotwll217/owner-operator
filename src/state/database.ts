import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  AgentRunStatus,
  ScheduleRunStatus,
  ScheduleRunTrigger,
  formatRelative,
  isSessionBoilerplate,
  type AgentRun,
  type AgentRunHarness,
  type AgentRunOutcome,
  type ScheduleDefinition,
  type ScheduleRun,
  type ScheduleTriggerContext,
  type ScheduledPayload,
  type ScheduleTrigger,
  type SessionStateRow,
  type ThreadDetails,
  type ThreadState,
  type EnrichmentCandidate,
} from "@owner-operator/core";
import { stateDatabasePath } from "../shared/paths";

export { type SessionStateRow } from "@owner-operator/core";

export function defaultDbPath(): string {
  return stateDatabasePath();
}

export interface ThreadObservation {
  id: string;
  repo?: string;
  project?: string;
  app?: string;
  source?: string;
  transcriptPath?: string;
  createdAt?: string;
  lastActiveAt?: string;
  lastMessageAt?: string;
  rawTopic?: string;
  state: ThreadState;
  stateReason?: string;
  diffAdded?: number;
  diffDeleted?: number;
}

export interface ThreadResolutionRow {
  id: string;
  state: ThreadState;
  lastMessageAt: string | null;
  enrichedThroughMessageAt: string | null;
}

export interface DetailsRow {
  threadId: string;
  version: number;
  createdAt: string;
  writtenBy: "poll" | "model" | "owner";
  state: ThreadState;
  stateReason: string | null;
  priority: number | null;
  topic: string | null;
  summary: string | null;
  nextSteps: string | null;
}

export interface RecordScanResult {
  added: boolean;
  stateChanged: { from: ThreadState; to: ThreadState } | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  repo TEXT,
  project TEXT,
  app TEXT,
  source TEXT,
  transcript_path TEXT,
  created_at TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  last_active_at TEXT,
  last_message_at TEXT,
  last_checked_at TEXT,
  diff_added INTEGER,
  diff_deleted INTEGER,
  raw_topic TEXT,
  owner_title TEXT,
  enriched_through_message_at TEXT
);

CREATE TABLE IF NOT EXISTS thread_details (
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  written_by TEXT NOT NULL CHECK (written_by IN ('poll', 'model', 'owner')),
  state TEXT NOT NULL CHECK (state IN ('needs-you', 'working', 'idle', 'done')),
  state_reason TEXT,
  priority INTEGER,
  topic TEXT,
  summary TEXT,
  next_steps TEXT,
  PRIMARY KEY (thread_id, version)
);

CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL,
  trigger_kind TEXT NOT NULL,
  trigger_json TEXT NOT NULL,
  payload_kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  cwd TEXT NOT NULL,
  timeout_seconds INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  next_run_at TEXT,
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_schedules_due
  ON schedules(enabled, next_run_at) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS schedule_runs (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL REFERENCES schedules(id),
  trigger TEXT NOT NULL,
  trigger_context_json TEXT,
  payload_snapshot_json TEXT NOT NULL,
  cwd TEXT NOT NULL,
  timeout_seconds INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  scheduled_for TEXT,
  started_at TEXT,
  finished_at TEXT,
  exit_code INTEGER,
  stdout_tail TEXT,
  stderr_tail TEXT,
  error TEXT,
  transcript_id TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_schedule_runs_job_created
  ON schedule_runs(schedule_id, created_at DESC);

CREATE TABLE IF NOT EXISTS schedule_event_watermarks (
  schedule_id TEXT NOT NULL REFERENCES schedules(id),
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  last_message_at TEXT NOT NULL,
  PRIMARY KEY (schedule_id, thread_id)
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  harness TEXT NOT NULL,
  task TEXT NOT NULL,
  cwd TEXT NOT NULL,
  parent_thread_id TEXT,
  model TEXT,
  depth INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'pending', 'running', 'completed', 'failed', 'cancelled', 'interrupted', 'lost'
  )),
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  activity TEXT,
  last_activity_at TEXT,
  child_session_id TEXT,
  acpx_record_id TEXT,
  result_tail TEXT,
  error TEXT,
  resume_of_run_id TEXT REFERENCES agent_runs(id),
  timeout_seconds INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_status_created
  ON agent_runs(status, created_at);

CREATE INDEX IF NOT EXISTS idx_agent_runs_child_session
  ON agent_runs(child_session_id) WHERE child_session_id IS NOT NULL;
`;

const AGENT_RUN_COLUMNS = `
  id, harness, task, cwd, parent_thread_id AS parentThreadId, model, depth, status,
  created_at AS createdAt, started_at AS startedAt, finished_at AS finishedAt,
  activity, last_activity_at AS lastActivityAt, child_session_id AS childSessionId,
  acpx_record_id AS acpxRecordId, result_tail AS resultTail, error,
  resume_of_run_id AS resumeOfRunId, timeout_seconds AS timeoutSeconds`;

export interface AgentRunInsert {
  id: string;
  harness: AgentRunHarness;
  task: string;
  cwd: string;
  parentThreadId?: string | null;
  model?: string | null;
  depth: number;
  timeoutSeconds: number;
  resumeOfRunId?: string | null;
  childSessionId?: string | null;
  acpxRecordId?: string | null;
}

type DetailsPatch = Partial<{
  state: ThreadState;
  stateReason: string | null;
  priority: number | null;
  topic: string | null;
  summary: string | null;
  nextSteps: string | null;
}>;

export class ThreadDb {
  private readonly db: DatabaseSync;
  private readonly now: () => string;

  constructor(dbPath: string = defaultDbPath(), options: { now?: () => string } = {}) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.now = options.now ?? (() => new Date().toISOString());
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec(SCHEMA);
  }

  private appendDetailsInTx(
    threadId: string,
    patch: DetailsPatch,
    writtenBy: DetailsRow["writtenBy"],
  ): { version: number; from: ThreadState | null; to: ThreadState } | null {
    const latest = this.latestDetails(threadId);
    const merged = {
      state: patch.state ?? latest?.state ?? "idle",
      stateReason: "stateReason" in patch
        ? patch.stateReason ?? null
        : patch.state !== undefined && patch.state !== latest?.state ? null : latest?.stateReason ?? null,
      priority: "priority" in patch ? patch.priority ?? null : latest?.priority ?? null,
      topic: "topic" in patch ? patch.topic ?? null : latest?.topic ?? null,
      summary: "summary" in patch ? patch.summary ?? null : latest?.summary ?? null,
      nextSteps: "nextSteps" in patch ? patch.nextSteps ?? null : latest?.nextSteps ?? null,
    };
    if (
      latest && latest.state === merged.state && latest.stateReason === merged.stateReason &&
      latest.priority === merged.priority && latest.topic === merged.topic &&
      latest.summary === merged.summary && latest.nextSteps === merged.nextSteps
    ) return null;
    const version = (latest?.version ?? 0) + 1;
    this.db.prepare(
      `INSERT INTO thread_details (
         thread_id, version, created_at, written_by, state, state_reason,
         priority, topic, summary, next_steps
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      threadId, version, this.now(), writtenBy, merged.state, merged.stateReason,
      merged.priority, merged.topic, merged.summary, merged.nextSteps,
    );
    return { version, from: latest?.state ?? null, to: merged.state };
  }

  recordScan(observation: ThreadObservation): RecordScanResult {
    const previous = this.resolutionRow(observation.id);
    const now = this.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(
        `INSERT INTO threads (
           id, repo, project, app, source, transcript_path, created_at,
           first_seen_at, last_seen_at, last_active_at, last_message_at,
           last_checked_at, diff_added, diff_deleted, raw_topic
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           repo = COALESCE(excluded.repo, threads.repo),
           project = COALESCE(excluded.project, threads.project),
           app = COALESCE(excluded.app, threads.app),
           source = COALESCE(excluded.source, threads.source),
           transcript_path = COALESCE(excluded.transcript_path, threads.transcript_path),
           created_at = COALESCE(excluded.created_at, threads.created_at),
           last_seen_at = excluded.last_seen_at,
           last_active_at = COALESCE(excluded.last_active_at, threads.last_active_at),
           last_message_at = COALESCE(excluded.last_message_at, threads.last_message_at),
           last_checked_at = excluded.last_checked_at,
           diff_added = COALESCE(excluded.diff_added, threads.diff_added),
           diff_deleted = COALESCE(excluded.diff_deleted, threads.diff_deleted),
           raw_topic = COALESCE(excluded.raw_topic, threads.raw_topic)`,
      ).run(
        observation.id, observation.repo ?? null, observation.project ?? null,
        observation.app ?? null, observation.source ?? null, observation.transcriptPath ?? null,
        observation.createdAt ?? null, now, now, observation.lastActiveAt ?? null,
        observation.lastMessageAt ?? null, now, observation.diffAdded ?? null,
        observation.diffDeleted ?? null, observation.rawTopic ?? null,
      );
      const edge = this.appendDetailsInTx(
        observation.id,
        { state: observation.state, ...(observation.stateReason !== undefined ? { stateReason: observation.stateReason } : {}) },
        "poll",
      );
      this.db.exec("COMMIT");
      return {
        added: !previous,
        stateChanged: edge?.from && edge.from !== edge.to ? { from: edge.from, to: edge.to } : null,
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  appendModelDetails(threadId: string, details: ThreadDetails, throughMessageAt?: string): number | null {
    const now = this.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT OR IGNORE INTO threads (id, first_seen_at, last_seen_at) VALUES (?, ?, ?)")
        .run(threadId, now, now);
      const edge = this.appendDetailsInTx(threadId, {
        priority: details.priority ?? null,
        topic: details.topic ?? null,
        summary: details.summary ?? null,
        nextSteps: details.nextSteps ?? null,
      }, "model");
      if (throughMessageAt !== undefined) {
        this.db.prepare("UPDATE threads SET enriched_through_message_at = ? WHERE id = ?")
          .run(throughMessageAt, threadId);
      }
      this.db.exec("COMMIT");
      return edge?.version ?? null;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  appendModelDetailsIfFresh(
    threadId: string,
    details: ThreadDetails,
    throughMessageAt: string,
  ): number | null {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.resolutionRow(threadId);
      // The thread may have flapped out of needs-you while the model ran — the sampled
      // message is unchanged, so the belief still lands (state is a lifecycle flag, not a
      // new message). But once a newer message has arrived the sample is stale: reject it
      // and let the next poll re-enrich. The watermark rejects an already-enriched message
      // and any out-of-order duplicate.
      if (
        !current || current.lastMessageAt !== throughMessageAt ||
        (current.enrichedThroughMessageAt ?? "") >= throughMessageAt
      ) {
        this.db.exec("COMMIT");
        return null;
      }
      const edge = this.appendDetailsInTx(threadId, {
        priority: details.priority ?? null,
        topic: details.topic ?? null,
        summary: details.summary ?? null,
        nextSteps: details.nextSteps ?? null,
      }, "model");
      this.db.prepare("UPDATE threads SET enriched_through_message_at = ? WHERE id = ?")
        .run(throughMessageAt, threadId);
      this.db.exec("COMMIT");
      return edge?.version ?? 0;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  latestDetails(threadId: string): DetailsRow | undefined {
    return this.db.prepare(
      `SELECT thread_id AS threadId, version, created_at AS createdAt,
              written_by AS writtenBy, state, state_reason AS stateReason,
              priority, topic, summary, next_steps AS nextSteps
       FROM thread_details WHERE thread_id = ? ORDER BY version DESC LIMIT 1`,
    ).get(threadId) as unknown as DetailsRow | undefined;
  }

  latestDetailsMap(): Map<string, ThreadDetails> {
    const rows = this.db.prepare(
      `SELECT thread_id AS threadId, priority, topic, summary, next_steps AS nextSteps
       FROM thread_details detail
       WHERE version = (SELECT MAX(version) FROM thread_details WHERE thread_id = detail.thread_id)`,
    ).all() as unknown as Array<DetailsRow>;
    return new Map(rows.map((row) => [row.threadId, {
      ...(row.topic != null ? { topic: row.topic } : {}),
      ...(row.summary != null ? { summary: row.summary } : {}),
      ...(row.nextSteps != null ? { nextSteps: row.nextSteps } : {}),
      ...(row.priority != null ? { priority: row.priority } : {}),
    }]));
  }

  resolutionRow(threadId: string): ThreadResolutionRow | undefined {
    return this.db.prepare(
      `SELECT t.id, detail.state, t.last_message_at AS lastMessageAt,
              t.enriched_through_message_at AS enrichedThroughMessageAt
       FROM threads t JOIN thread_details detail ON detail.thread_id = t.id
        AND detail.version = (SELECT MAX(version) FROM thread_details WHERE thread_id = t.id)
       WHERE t.id = ?`,
    ).get(threadId) as unknown as ThreadResolutionRow | undefined;
  }

  listSessionState(options: { activeSince?: string } = {}): SessionStateRow[] {
    const where = options.activeSince
      ? "WHERE detail.state != 'done' AND (t.last_active_at >= ? OR detail.state = 'needs-you')"
      : "WHERE detail.state != 'done'";
    const statement = this.db.prepare(
      `SELECT t.id, COALESCE(t.source, '') AS source, COALESCE(t.repo, '') AS repo,
              COALESCE(t.app, '') AS app,
              COALESCE(t.owner_title, detail.topic, t.raw_topic, '') AS topic,
              COALESCE(detail.topic, '') AS generatedTopic, t.owner_title AS ownerTitle,
              detail.summary, detail.next_steps AS nextSteps, detail.priority, detail.state,
              detail.state_reason AS stateReason, detail.created_at AS stateSince,
              t.last_active_at AS lastActiveAt,
              t.created_at AS createdAt, t.last_message_at AS lastMessageAt,
              t.diff_added AS diffAdded, t.diff_deleted AS diffDeleted,
              (SELECT run.parent_thread_id FROM agent_runs run
                WHERE run.child_session_id = t.id AND run.parent_thread_id IS NOT NULL
                ORDER BY run.created_at DESC LIMIT 1) AS parentThreadId
       FROM threads t JOIN thread_details detail ON detail.thread_id = t.id
        AND detail.version = (SELECT MAX(version) FROM thread_details WHERE thread_id = t.id)
       ${where}
       ORDER BY CASE detail.state WHEN 'needs-you' THEN 0 WHEN 'working' THEN 1 WHEN 'idle' THEN 2 ELSE 3 END,
                t.last_message_at DESC, t.repo COLLATE NOCASE ASC`,
    );
    const rows = (options.activeSince ? statement.all(options.activeSince) : statement.all()) as unknown as
      Array<Omit<SessionStateRow, "lastActive">>;
    const nowMs = Date.parse(this.now());
    return rows
      // Generated/owner titles are deliberate user-facing labels. Apply the legacy
      // transport-noise classifier only to raw topics; its broad scan-time patterns must
      // never hide a real title produced after inspecting the conversation.
      .filter((row) => row.ownerTitle != null || row.generatedTopic.trim() || !isSessionBoilerplate(row.topic))
      .map((row) => ({
        ...row,
        lastActive: row.lastMessageAt ? formatRelative((nowMs - Date.parse(row.lastMessageAt)) / 1000) : "",
      }));
  }

  listEnrichmentCandidates(): EnrichmentCandidate[] {
    const ids = this.db.prepare(
      `SELECT t.id FROM threads t JOIN thread_details detail ON detail.thread_id = t.id
        AND detail.version = (SELECT MAX(version) FROM thread_details WHERE thread_id = t.id)
       WHERE detail.state = 'needs-you' AND t.last_message_at IS NOT NULL
         AND (t.enriched_through_message_at IS NULL OR t.enriched_through_message_at < t.last_message_at)
       ORDER BY t.last_message_at ASC`,
    ).all() as Array<{ id: string }>;
    const rows = new Map(this.listSessionState().map((row) => [row.id, row]));
    return ids.flatMap(({ id }) => {
      const row = rows.get(id);
      const resolution = this.resolutionRow(id);
      return row ? [{ ...row, enrichedThroughMessageAt: resolution?.enrichedThroughMessageAt ?? null }] : [];
    });
  }

  markDone(ids: readonly string[]): { markedIds: string[]; alreadyDoneIds: string[]; missingIds: string[] } {
    const unique = [...new Set(ids)];
    const markedIds: string[] = [];
    const alreadyDoneIds: string[] = [];
    const missingIds: string[] = [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const id of unique) {
        if (!this.db.prepare("SELECT 1 FROM threads WHERE id = ?").get(id)) {
          missingIds.push(id);
          continue;
        }
        if (this.appendDetailsInTx(id, { state: "done" }, "owner")) markedIds.push(id);
        else alreadyDoneIds.push(id);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { markedIds, alreadyDoneIds, missingIds };
  }

  setOwnerTitle(threadId: string, title: string): boolean {
    return Number(this.db.prepare("UPDATE threads SET owner_title = ? WHERE id = ?")
      .run(title.trim() || null, threadId).changes) > 0;
  }

  purgeBlacklisted(blacklist: { paths: string[]; repos: string[] }): number {
    const conditions: string[] = [];
    const params: string[] = [];
    for (const repo of blacklist.repos) { conditions.push("lower(repo) = lower(?)"); params.push(repo); }
    for (const path of blacklist.paths) {
      conditions.push("(project = ? COLLATE NOCASE OR project LIKE ? || '/%' COLLATE NOCASE)");
      params.push(path, path);
    }
    if (!conditions.length) return 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const where = conditions.join(" OR ");
      this.db.prepare(
        `DELETE FROM schedule_event_watermarks WHERE thread_id IN (SELECT id FROM threads WHERE ${where})`,
      ).run(...params);
      const deleted = Number(this.db.prepare(`DELETE FROM threads WHERE ${where}`).run(...params).changes);
      this.db.exec("COMMIT");
      return deleted;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  saveSchedule(schedule: ScheduleDefinition): void {
    this.db.prepare(
      `INSERT INTO schedules (
         id, name, enabled, trigger_kind, trigger_json, payload_kind, payload_json,
         cwd, timeout_seconds, revision, created_at, updated_at, next_run_at, deleted_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, enabled = excluded.enabled,
         trigger_kind = excluded.trigger_kind, trigger_json = excluded.trigger_json,
         payload_kind = excluded.payload_kind, payload_json = excluded.payload_json,
         cwd = excluded.cwd, timeout_seconds = excluded.timeout_seconds,
         revision = excluded.revision, updated_at = excluded.updated_at,
         next_run_at = excluded.next_run_at, deleted_at = NULL`,
    ).run(
      schedule.id, schedule.name, schedule.enabled ? 1 : 0, schedule.trigger.kind,
      JSON.stringify(schedule.trigger), schedule.payload.kind, JSON.stringify(schedule.payload),
      schedule.cwd, schedule.timeoutSeconds, schedule.revision,
      schedule.createdAt, schedule.updatedAt, schedule.nextRunAt,
    );
  }

  listSchedules(options: { includeDeleted?: boolean } = {}): ScheduleDefinition[] {
    const rows = this.db.prepare(
      `SELECT id, name, enabled, trigger_json AS triggerJson, payload_json AS payloadJson,
              cwd, timeout_seconds AS timeoutSeconds, revision, created_at AS createdAt,
              updated_at AS updatedAt, next_run_at AS nextRunAt
       FROM schedules ${options.includeDeleted ? "" : "WHERE deleted_at IS NULL"}
       ORDER BY name COLLATE NOCASE`,
    ).all() as unknown as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id), name: String(row.name), enabled: Boolean(row.enabled),
      trigger: JSON.parse(String(row.triggerJson)) as ScheduleTrigger,
      payload: JSON.parse(String(row.payloadJson)) as ScheduledPayload,
      cwd: String(row.cwd), timeoutSeconds: Number(row.timeoutSeconds), revision: Number(row.revision),
      createdAt: String(row.createdAt), updatedAt: String(row.updatedAt),
      nextRunAt: row.nextRunAt == null ? null : String(row.nextRunAt),
    }));
  }

  scheduleById(id: string): ScheduleDefinition | undefined {
    return this.listSchedules().find((schedule) => schedule.id === id);
  }

  dueSchedules(nowIso: string): ScheduleDefinition[] {
    const ids = this.db.prepare(
      `SELECT id FROM schedules WHERE deleted_at IS NULL AND enabled = 1
       AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at ASC, id ASC`,
    ).all(nowIso) as Array<{ id: string }>;
    return ids.flatMap(({ id }) => this.scheduleById(id) ?? []);
  }

  softDeleteSchedule(id: string): boolean {
    return Number(this.db.prepare(
      "UPDATE schedules SET enabled = 0, deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
    ).run(this.now(), this.now(), id).changes) > 0;
  }

  updateScheduleNextRun(
    id: string,
    nextRunAt: string | null,
    enabled: boolean,
    expectedRevision: number,
  ): boolean {
    return Number(this.db.prepare(
      `UPDATE schedules SET next_run_at = ?, enabled = ?, updated_at = ?, revision = revision + 1
       WHERE id = ? AND deleted_at IS NULL AND revision = ?`,
    ).run(nextRunAt, enabled ? 1 : 0, this.now(), id, expectedRevision).changes) > 0;
  }

  claimScheduledRun(params: {
    id: string;
    schedule: ScheduleDefinition;
    scheduledFor: string;
    nextRunAt: string | null;
    enabled: boolean;
    triggerContext: ScheduleTriggerContext;
  }): ScheduleRun | null {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const claimed = Number(this.db.prepare(
        `UPDATE schedules SET next_run_at = ?, enabled = ?, updated_at = ?, revision = revision + 1
         WHERE id = ? AND deleted_at IS NULL AND enabled = 1 AND revision = ? AND next_run_at = ?`,
      ).run(
        params.nextRunAt,
        params.enabled ? 1 : 0,
        this.now(),
        params.schedule.id,
        params.schedule.revision,
        params.scheduledFor,
      ).changes) > 0;
      if (!claimed) {
        this.db.exec("COMMIT");
        return null;
      }
      const run = this.insertScheduleRun({
        id: params.id,
        schedule: params.schedule,
        trigger: ScheduleRunTrigger.Scheduled,
        scheduledFor: params.scheduledFor,
        triggerContext: params.triggerContext,
        createdAt: this.now(),
      });
      this.db.exec("COMMIT");
      return run;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  createScheduleRun(params: {
    id: string; schedule: ScheduleDefinition; trigger: ScheduleRunTrigger;
    scheduledFor: string | null; triggerContext?: ScheduleTriggerContext;
  }): ScheduleRun {
    return this.insertScheduleRun({ ...params, createdAt: this.now() });
  }

  private insertScheduleRun(params: {
    id: string;
    schedule: ScheduleDefinition;
    trigger: ScheduleRunTrigger;
    scheduledFor: string | null;
    triggerContext?: ScheduleTriggerContext;
    createdAt: string;
  }): ScheduleRun {
    this.db.prepare(
      `INSERT INTO schedule_runs (
         id, schedule_id, trigger, trigger_context_json, payload_snapshot_json,
         cwd, timeout_seconds, status, created_at, scheduled_for, started_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      params.id, params.schedule.id, params.trigger,
      params.triggerContext === undefined ? null : JSON.stringify(params.triggerContext),
      JSON.stringify(params.schedule.payload), params.schedule.cwd, params.schedule.timeoutSeconds,
      ScheduleRunStatus.Running, params.createdAt, params.scheduledFor, params.createdAt,
    );
    return this.scheduleRunById(params.id)!;
  }

  finishScheduleRun(id: string, outcome: {
    status: ScheduleRunStatus.Completed | ScheduleRunStatus.Failed | ScheduleRunStatus.Interrupted;
    exitCode: number | null; stdoutTail: string | null; stderrTail: string | null;
    error: string | null; transcriptId: string | null;
  }): ScheduleRun {
    this.db.prepare(
      `UPDATE schedule_runs SET status = ?, finished_at = ?, exit_code = ?, stdout_tail = ?,
       stderr_tail = ?, error = ?, transcript_id = ? WHERE id = ?`,
    ).run(
      outcome.status, this.now(), outcome.exitCode, outcome.stdoutTail,
      outcome.stderrTail, outcome.error, outcome.transcriptId, id,
    );
    return this.scheduleRunById(id)!;
  }

  markRunningScheduleRunsInterrupted(reason: string): number {
    return Number(this.db.prepare(
      "UPDATE schedule_runs SET status = ?, finished_at = ?, error = ? WHERE status = ?",
    ).run(ScheduleRunStatus.Interrupted, this.now(), reason, ScheduleRunStatus.Running).changes);
  }

  createAgentRun(insert: AgentRunInsert): AgentRun {
    this.db.prepare(
      `INSERT INTO agent_runs (
         id, harness, task, cwd, parent_thread_id, model, depth, status, created_at,
         child_session_id, acpx_record_id, resume_of_run_id, timeout_seconds
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      insert.id, insert.harness, insert.task, insert.cwd, insert.parentThreadId ?? null,
      insert.model ?? null, insert.depth, AgentRunStatus.Pending, this.now(),
      insert.childSessionId ?? null, insert.acpxRecordId ?? null,
      insert.resumeOfRunId ?? null, insert.timeoutSeconds,
    );
    return this.agentRunById(insert.id)!;
  }

  /** The most recent run whose child session equals this id — the depth-guard and monitor-join
   * lookup. A thread that is some run's child cannot itself be a delegating parent at depth 1. */
  agentRunByChildSession(childSessionId: string): AgentRun | undefined {
    return this.db.prepare(
      `SELECT ${AGENT_RUN_COLUMNS} FROM agent_runs
       WHERE child_session_id = ? ORDER BY created_at DESC LIMIT 1`,
    ).get(childSessionId) as unknown as AgentRun | undefined;
  }

  /** Start the oldest pending run iff fewer than `maxRunning` rows are running — one transaction,
   * so a concurrent claim can never overshoot the cap. */
  claimNextPendingAgentRun(maxRunning: number): AgentRun | null {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const { running } = this.db.prepare(
        "SELECT COUNT(*) AS running FROM agent_runs WHERE status = ?",
      ).get(AgentRunStatus.Running) as { running: number };
      if (running >= maxRunning) {
        this.db.exec("COMMIT");
        return null;
      }
      const next = this.db.prepare(
        "SELECT id FROM agent_runs WHERE status = ? ORDER BY created_at ASC, rowid ASC LIMIT 1",
      ).get(AgentRunStatus.Pending) as { id: string } | undefined;
      if (!next) {
        this.db.exec("COMMIT");
        return null;
      }
      this.db.prepare(
        "UPDATE agent_runs SET status = ?, started_at = ? WHERE id = ?",
      ).run(AgentRunStatus.Running, this.now(), next.id);
      this.db.exec("COMMIT");
      return this.agentRunById(next.id)!;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Explicit activity from the child's runtime; rejected once the row is terminal. */
  recordAgentRunActivity(id: string, update: {
    activity?: string;
    childSessionId?: string;
    acpxRecordId?: string;
  }): AgentRun | null {
    const changed = Number(this.db.prepare(
      `UPDATE agent_runs SET
         activity = COALESCE(?, activity),
         last_activity_at = ?,
         child_session_id = COALESCE(?, child_session_id),
         acpx_record_id = COALESCE(?, acpx_record_id)
       WHERE id = ? AND status = ?`,
    ).run(
      update.activity ?? null, this.now(), update.childSessionId ?? null,
      update.acpxRecordId ?? null, id, AgentRunStatus.Running,
    ).changes) > 0;
    return changed ? this.agentRunById(id)! : null;
  }

  /** Finalize a run. Terminal states are monotonic: only pending/running rows can finish. */
  finishAgentRun(id: string, outcome: AgentRunOutcome): AgentRun | null {
    const changed = Number(this.db.prepare(
      `UPDATE agent_runs SET status = ?, finished_at = ?, result_tail = ?, error = ?,
         child_session_id = COALESCE(?, child_session_id),
         acpx_record_id = COALESCE(?, acpx_record_id)
       WHERE id = ? AND status IN (?, ?)`,
    ).run(
      outcome.status, this.now(), outcome.resultTail, outcome.error,
      outcome.childSessionId ?? null, outcome.acpxRecordId ?? null,
      id, AgentRunStatus.Pending, AgentRunStatus.Running,
    ).changes) > 0;
    return changed ? this.agentRunById(id)! : null;
  }

  markRunningAgentRunsInterrupted(reason: string): string[] {
    const ids = (this.db.prepare(
      "SELECT id FROM agent_runs WHERE status = ? ORDER BY created_at ASC",
    ).all(AgentRunStatus.Running) as Array<{ id: string }>).map((row) => row.id);
    if (ids.length) {
      this.db.prepare(
        "UPDATE agent_runs SET status = ?, finished_at = ?, error = ? WHERE status = ?",
      ).run(AgentRunStatus.Interrupted, this.now(), reason, AgentRunStatus.Running);
    }
    return ids;
  }

  /** Reconciliation sweep: a running row with no live in-process turn and no activity since
   * the cutoff is lost. Liveness comes from the executor's active-turn set — persisted rows
   * alone never keep a run alive, and a live turn is never reclaimed. */
  markAgentRunsLost(liveRunIds: readonly string[], activityCutoffIso: string): string[] {
    const live = new Set(liveRunIds);
    const stale = (this.db.prepare(
      `SELECT id FROM agent_runs WHERE status = ?
        AND COALESCE(last_activity_at, started_at, created_at) < ?
       ORDER BY created_at ASC`,
    ).all(AgentRunStatus.Running, activityCutoffIso) as Array<{ id: string }>)
      .map((row) => row.id)
      .filter((id) => !live.has(id));
    const mark = this.db.prepare(
      "UPDATE agent_runs SET status = ?, finished_at = ?, error = ? WHERE id = ? AND status = ?",
    );
    for (const id of stale) {
      mark.run(AgentRunStatus.Lost, this.now(), "run lost: no live turn and no recent activity", id, AgentRunStatus.Running);
    }
    return stale;
  }

  agentRunById(id: string): AgentRun | undefined {
    return this.db.prepare(
      `SELECT ${AGENT_RUN_COLUMNS} FROM agent_runs WHERE id = ?`,
    ).get(id) as unknown as AgentRun | undefined;
  }

  listAgentRuns(filter: { parentThreadId?: string } = {}): AgentRun[] {
    const sql = `SELECT ${AGENT_RUN_COLUMNS} FROM agent_runs
                 ${filter.parentThreadId !== undefined ? "WHERE parent_thread_id = ?" : ""}
                 ORDER BY created_at DESC, rowid DESC`;
    const statement = this.db.prepare(sql);
    return (
      filter.parentThreadId !== undefined ? statement.all(filter.parentThreadId) : statement.all()
    ) as unknown as AgentRun[];
  }

  listNeedsYouMessageVersions(): Array<{ threadId: string; lastMessageAt: string }> {
    return this.db.prepare(
      `SELECT t.id AS threadId, t.last_message_at AS lastMessageAt
       FROM threads t JOIN thread_details detail ON detail.thread_id = t.id
        AND detail.version = (SELECT MAX(version) FROM thread_details WHERE thread_id = t.id)
       WHERE detail.state = 'needs-you' AND t.last_message_at IS NOT NULL
       ORDER BY t.last_message_at ASC`,
    ).all() as Array<{ threadId: string; lastMessageAt: string }>;
  }

  claimNeedsYouScheduleRun(params: {
    id: string; schedule: ScheduleDefinition;
    changes: readonly { threadId: string; lastMessageAt: string }[];
  }): { run: ScheduleRun; threadIds: string[]; observedThrough: string } | null {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const read = this.db.prepare(
        "SELECT last_message_at AS lastMessageAt FROM schedule_event_watermarks WHERE schedule_id = ? AND thread_id = ?",
      );
      const fresh = params.changes.filter((change) => {
        const prior = read.get(params.schedule.id, change.threadId) as { lastMessageAt: string } | undefined;
        return prior?.lastMessageAt !== change.lastMessageAt;
      });
      if (!fresh.length) { this.db.exec("COMMIT"); return null; }
      const observedThrough = fresh.reduce(
        (latest, change) => change.lastMessageAt > latest ? change.lastMessageAt : latest,
        fresh[0].lastMessageAt,
      );
      const threadIds = fresh.map((change) => change.threadId);
      const context = { threadIds, observedThrough };
      const createdAt = this.now();
      const run = this.insertScheduleRun({
        id: params.id,
        schedule: params.schedule,
        trigger: ScheduleRunTrigger.NeedsYou,
        scheduledFor: null,
        triggerContext: context,
        createdAt,
      });
      const write = this.db.prepare(
        `INSERT INTO schedule_event_watermarks (schedule_id, thread_id, last_message_at)
         VALUES (?, ?, ?) ON CONFLICT(schedule_id, thread_id)
         DO UPDATE SET last_message_at = excluded.last_message_at`,
      );
      for (const change of fresh) write.run(params.schedule.id, change.threadId, change.lastMessageAt);
      this.db.exec("COMMIT");
      return { run, threadIds, observedThrough };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listScheduleRuns(scheduleId?: string): ScheduleRun[] {
    const sql = `SELECT id, schedule_id AS scheduleId, trigger, status,
                        scheduled_for AS scheduledFor, started_at AS startedAt,
                        finished_at AS finishedAt, exit_code AS exitCode,
                        stdout_tail AS stdoutTail, stderr_tail AS stderrTail,
                        error, transcript_id AS transcriptId, attempt_count AS attemptCount
                 FROM schedule_runs ${scheduleId ? "WHERE schedule_id = ?" : ""}
                 ORDER BY created_at DESC, rowid DESC`;
    return (scheduleId ? this.db.prepare(sql).all(scheduleId) : this.db.prepare(sql).all()) as unknown as ScheduleRun[];
  }

  private scheduleRunById(id: string): ScheduleRun | undefined {
    return this.db.prepare(
      `SELECT id, schedule_id AS scheduleId, trigger, status,
              scheduled_for AS scheduledFor, started_at AS startedAt,
              finished_at AS finishedAt, exit_code AS exitCode,
              stdout_tail AS stdoutTail, stderr_tail AS stderrTail,
              error, transcript_id AS transcriptId, attempt_count AS attemptCount
       FROM schedule_runs WHERE id = ?`,
    ).get(id) as unknown as ScheduleRun | undefined;
  }

  close(): void {
    this.db.close();
  }
}
