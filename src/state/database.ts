import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  AGENT_RUN_EFFORTS,
  AgentRunStatus,
  ScheduleRunStatus,
  ScheduleRunTrigger,
  formatRelative,
  harnessIdentityObservation,
  isSessionBoilerplate,
  type AgentRun,
  type AgentRunActivityUpdate,
  type AgentRunHarness,
  type AgentRunEffort,
  type AgentRunOutcome,
  type AgentRunLogRecord,
  type AgentRunResultRecord,
  type AgentRunStreamEvent,
  type ScheduleDefinition,
  type ScheduleRun,
  type ScheduleTriggerContext,
  type ScheduledPayload,
  type ScheduleTrigger,
  type SessionStateRow,
  type ThreadDetails,
  type ThreadEnrichment,
  type ThreadState,
  type EnrichmentCandidate,
  type RegisteredWorktree,
} from "@owner-operator/core";
import { stateDatabasePath } from "../shared/paths";

export { type SessionStateRow } from "@owner-operator/core";

const AGENT_RUN_EFFORT_SQL = AGENT_RUN_EFFORTS.map((effort) => `'${effort}'`).join(", ");

/** How long a working session's assessment stands before it is made again. The owner asked for
 * roughly four minutes: long enough not to re-read a turn constantly, short enough that a row
 * they are watching keeps up with it. */
const WORKING_REASSESS_MS = 4 * 60 * 1_000;

/** One State-owned definition of an active delegated child. Every persisted owner-attention
 * projection embeds this predicate instead of growing a parallel run lifecycle. */
const HAS_ACTIVE_CHILD_SQL = `EXISTS (
  SELECT 1 FROM agent_runs active_child
  WHERE active_child.parent_thread_id = t.id
    AND active_child.status IN ('${AgentRunStatus.Pending}', '${AgentRunStatus.Running}')
)`;

const EFFECTIVE_THREAD_STATE_SQL = `CASE
  WHEN detail.state = 'done' THEN 'done'
  WHEN ${HAS_ACTIVE_CHILD_SQL} THEN 'working'
  ELSE detail.state
END`;

const CHILD_EVIDENCE_SQL = `(SELECT json_group_array(json_object(
  'id', id, 'source', source, 'lastMessageAt', last_message_at, 'runId', run_id, 'status', status
)) FROM (
  SELECT child.id, child.source, child.last_message_at, run.id AS run_id, run.status
  FROM agent_runs run JOIN threads child ON child.id = run.child_session_id
  WHERE run.parent_thread_id = t.id
  ORDER BY run.status IN ('${AgentRunStatus.Pending}', '${AgentRunStatus.Running}') DESC,
    run.created_at DESC, run.id
))`;

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
  diffAdded?: number;
  diffDeleted?: number;
}

export interface ThreadResolutionRow {
  id: string;
  state: ThreadState;
  lastMessageAt: string | null;
  enrichedThroughMessageAt: string | null;
  enrichedWhileWorking: boolean;
  enrichedChildren: string;
  enrichmentContract: number;
  childrenEvidence: string;
}

export interface StatusSummaryRevision {
  version: number;
  createdAt: string;
  statusSummary: string;
  /** Message index this revision was written from, under a tool-inclusive read. */
  bookmarkIndex: number | null;
}

export interface DetailsRow {
  threadId: string;
  version: number;
  createdAt: string;
  writtenBy: "poll" | "model" | "owner";
  state: ThreadState;
  priority: number | null;
  topic: string | null;
  statusSummary: string | null;
  /** Message index this revision was written from, under a tool-inclusive read. */
  bookmarkIndex: number | null;
  bookmarkMessageAt: string | null;
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
  enriched_through_message_at TEXT,
  enriched_while_working INTEGER NOT NULL DEFAULT 0,
  enrichment_contract INTEGER NOT NULL DEFAULT 0,
  last_enriched_at TEXT
);

CREATE TABLE IF NOT EXISTS thread_details (
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  written_by TEXT NOT NULL CHECK (written_by IN ('poll', 'model', 'owner')),
  state TEXT NOT NULL CHECK (state IN ('needs-you', 'working', 'idle', 'done')),
  priority INTEGER,
  topic TEXT,
  status_summary TEXT,
  bookmark_index INTEGER,
  bookmark_message_at TEXT,
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
  effort TEXT CHECK (effort IS NULL OR effort IN (${AGENT_RUN_EFFORT_SQL})),
  effort_applied INTEGER NOT NULL DEFAULT 0 CHECK (effort_applied IN (0, 1)),
  harness_model TEXT,
  harness_effort TEXT CHECK (harness_effort IS NULL OR harness_effort IN (${AGENT_RUN_EFFORT_SQL})),
  harness_identity_observed INTEGER NOT NULL DEFAULT 0 CHECK (harness_identity_observed IN (0, 1)),
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
  retry_of_run_id TEXT REFERENCES agent_runs(id),
  resume_of_run_id TEXT REFERENCES agent_runs(id),
  timeout_seconds INTEGER NOT NULL,
  CHECK (retry_of_run_id IS NULL OR resume_of_run_id IS NULL)
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_status_created
  ON agent_runs(status, created_at);

CREATE INDEX IF NOT EXISTS idx_agent_runs_child_session
  ON agent_runs(child_session_id) WHERE child_session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_agent_runs_parent_created
  ON agent_runs(parent_thread_id, created_at DESC) WHERE parent_thread_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS agent_run_events (
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  at TEXT NOT NULL,
  record TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  PRIMARY KEY (run_id, seq)
);

CREATE TABLE IF NOT EXISTS worktrees (
  id TEXT PRIMARY KEY,
  repository TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  git_common_dir TEXT NOT NULL,
  created_by_thread_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS thread_worktrees (
  thread_id TEXT PRIMARY KEY,
  worktree_id TEXT NOT NULL REFERENCES worktrees(id),
  selected_at TEXT NOT NULL
);
`;

const CURRENT_ENRICHMENT_CONTRACT = 2;

const WORKTREE_COLUMNS = `
  id, repository, path, git_common_dir AS gitCommonDir,
  created_by_thread_id AS createdByThreadId, created_at AS createdAt`;

const JOINED_WORKTREE_COLUMNS = `
  w.id, w.repository, w.path, w.git_common_dir AS gitCommonDir,
  w.created_by_thread_id AS createdByThreadId, w.created_at AS createdAt`;

const AGENT_RUN_COLUMNS = `
  id, harness, task, cwd, parent_thread_id AS parentThreadId, model, effort,
  effort_applied AS effortApplied, harness_model AS harnessModel,
  harness_effort AS harnessEffort, harness_identity_observed AS harnessIdentityObserved,
  depth, status,
  created_at AS createdAt, started_at AS startedAt, finished_at AS finishedAt,
  activity, last_activity_at AS lastActivityAt, child_session_id AS childSessionId,
  acpx_record_id AS acpxRecordId, result_tail AS resultTail, error,
  retry_of_run_id AS retryOfRunId,
  resume_of_run_id AS resumeOfRunId, timeout_seconds AS timeoutSeconds`;

/** Per-run event-log retention: ACPX's own session event-log default of 5 segments of 64 MiB
 * (https://github.com/openclaw/acpx/blob/fd173f04aa1b56f9e3f5ca5190c034ddcae28792/src/session/event-log.ts#L5-L6).
 * Past it the oldest stream events go first; the terminal record is never evicted. */
export const AGENT_RUN_EVENT_LOG_MAX_BYTES = 5 * 64 * 1024 * 1024;

export interface AgentRunLogEntry {
  seq: number;
  at: string;
  record: AgentRunLogRecord;
}

export interface AgentRunInsert {
  id: string;
  harness: AgentRunHarness;
  task: string;
  cwd: string;
  parentThreadId?: string | null;
  model?: string | null;
  effort?: AgentRunEffort | null;
  depth: number;
  timeoutSeconds: number;
  retryOfRunId?: string | null;
  resumeOfRunId?: string | null;
  childSessionId?: string | null;
  acpxRecordId?: string | null;
}

type AgentRunDbRow = Omit<AgentRun, "effortApplied" | "harnessIdentity"> & {
  effortApplied: number;
  harnessModel: string | null;
  harnessEffort: AgentRunEffort | null;
  harnessIdentityObserved: number;
};

function toAgentRun(row: AgentRunDbRow | undefined): AgentRun | undefined {
  if (!row) return undefined;
  const { harnessModel, harnessEffort, harnessIdentityObserved, ...run } = row;
  const harnessIdentity = harnessIdentityObservation({ model: harnessModel, effort: harnessEffort });
  void harnessIdentityObserved;
  return {
    ...run,
    effortApplied: Boolean(row.effortApplied),
    harnessIdentity,
  };
}

type DetailsPatch = Partial<{
  state: ThreadState;
  priority: number | null;
  topic: string | null;
  statusSummary: string | null;
  bookmark: { index: number; messageAt: string } | null;
}>;

export class ThreadDb {
  private readonly db: DatabaseSync;
  private readonly now: () => string;
  /** Stored event-log bytes per run, loaded on first append; a run only streams in one daemon. */
  private readonly eventLogBytes = new Map<string, number>();

  private readonly eventLogMaxBytes: number;

  constructor(dbPath: string = defaultDbPath(), options: { now?: () => string; eventLogMaxBytes?: number } = {}) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.now = options.now ?? (() => new Date().toISOString());
    this.eventLogMaxBytes = options.eventLogMaxBytes ?? AGENT_RUN_EVENT_LOG_MAX_BYTES;
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec(SCHEMA);
    this.migrateSessionSummaries();
    this.migrateAgentRunEffort();
  }

  private migrateSessionSummaries(): void {
    const columns = new Set(this.db.prepare("PRAGMA table_info(thread_details)").all().map((row) => row.name));
    const threads = new Set(this.db.prepare("PRAGMA table_info(threads)").all().map((row) => row.name));
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (!threads.has("enriched_while_working")) {
        this.db.exec("ALTER TABLE threads ADD COLUMN enriched_while_working INTEGER NOT NULL DEFAULT 0");
      }
      if (!threads.has("enriched_children")) {
        this.db.exec("ALTER TABLE threads ADD COLUMN enriched_children TEXT NOT NULL DEFAULT '[]'");
      }
      // Added columns, so every existing revision and its history survive the upgrade.
      if (!threads.has("last_enriched_at")) {
        this.db.exec("ALTER TABLE threads ADD COLUMN last_enriched_at TEXT");
      }
      if (!threads.has("enrichment_contract")) {
        this.db.exec("ALTER TABLE threads ADD COLUMN enrichment_contract INTEGER NOT NULL DEFAULT 0");
      }
      // The stored column takes the name the owner uses for it. A rename keeps every revision
      // and its history in place; the data is untouched.
      if (columns.has("summary") && !columns.has("status_summary")) {
        this.db.exec("ALTER TABLE thread_details RENAME COLUMN summary TO status_summary");
      }
      if (!columns.has("bookmark_index")) {
        this.db.exec("ALTER TABLE thread_details ADD COLUMN bookmark_index INTEGER");
        this.db.exec("ALTER TABLE thread_details ADD COLUMN bookmark_message_at TEXT");
      }
      if (columns.has("next_steps") || columns.has("state_reason")) {
        this.db.exec("UPDATE threads SET enriched_through_message_at = NULL");
        if (columns.has("next_steps")) this.db.exec("ALTER TABLE thread_details DROP COLUMN next_steps");
        if (columns.has("state_reason")) this.db.exec("ALTER TABLE thread_details DROP COLUMN state_reason");
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Additive migration for issue #104. Existing rows deliberately retain NULL effort. */
  private migrateAgentRunEffort(): void {
    const columns = new Set(
      (this.db.prepare("PRAGMA table_info(agent_runs)").all() as Array<{ name: string }>)
        .map(({ name }) => name),
    );
    if (!columns.has("effort")) {
      this.db.exec(
        `ALTER TABLE agent_runs ADD COLUMN effort TEXT
         CHECK (effort IS NULL OR effort IN (${AGENT_RUN_EFFORT_SQL}))`,
      );
    }
    if (!columns.has("effort_applied")) {
      this.db.exec(
        "ALTER TABLE agent_runs ADD COLUMN effort_applied INTEGER NOT NULL DEFAULT 0 "
        + "CHECK (effort_applied IN (0, 1))",
      );
    }
    if (!columns.has("harness_model")) this.db.exec("ALTER TABLE agent_runs ADD COLUMN harness_model TEXT");
    if (!columns.has("harness_effort")) {
      this.db.exec(`ALTER TABLE agent_runs ADD COLUMN harness_effort TEXT
        CHECK (harness_effort IS NULL OR harness_effort IN (${AGENT_RUN_EFFORT_SQL}))`);
    }
    if (!columns.has("harness_identity_observed")) {
      this.db.exec("ALTER TABLE agent_runs ADD COLUMN harness_identity_observed INTEGER NOT NULL DEFAULT 0 "
        + "CHECK (harness_identity_observed IN (0, 1))");
    }
    this.migrateAgentRunRelationships();
    const currentColumns = new Set(
      (this.db.prepare("PRAGMA table_info(agent_runs)").all() as Array<{ name: string }>)
        .map(({ name }) => name),
    );
    const tableSql = (this.db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_runs'",
    ).get() as { sql: string }).sql;
    const currentEffortCheck = (column: "effort" | "harness_effort"): boolean => {
      const definition = new RegExp(`(?:^|[,\\n])\\s*${column}\\s+TEXT\\s+CHECK\\s*\\([^\\n]*`, "i").exec(tableSql)?.[0] ?? "";
      return definition.includes("'max'") && definition.includes("'ultra'");
    };
    if ((currentColumns.has("effort") && !currentEffortCheck("effort"))
      || (currentColumns.has("harness_effort") && !currentEffortCheck("harness_effort"))) {
      this.rebuildAgentRunsForCurrentEfforts();
    }
  }

  /** Split the former overloaded relationship column by the referenced run's terminal status. The
   * table rebuild preserves every row, exact self-reference, and documented index. */
  private migrateAgentRunRelationships(): void {
    const columns = new Set(
      (this.db.prepare("PRAGMA table_info(agent_runs)").all() as Array<{ name: string }>)
        .map(({ name }) => name),
    );
    if (columns.has("retry_of_run_id")) {
      if (!columns.has("resume_of_run_id")) throw new Error("agent_runs resume relationship column is missing");
      return;
    }
    if (!columns.has("resume_of_run_id")) throw new Error("agent_runs legacy relationship column is missing");

    const invalid = this.db.prepare(
      `SELECT run.id, run.resume_of_run_id AS referencedRunId, referenced.status
       FROM agent_runs AS run
       LEFT JOIN agent_runs AS referenced ON referenced.id = run.resume_of_run_id
       WHERE run.resume_of_run_id IS NOT NULL
         AND (referenced.id IS NULL OR referenced.status NOT IN ('completed','failed','interrupted','lost'))
       LIMIT 1`,
    ).get() as { id: string; referencedRunId: string; status: string | null } | undefined;
    if (invalid) {
      throw new Error(
        `cannot classify agent run ${invalid.id} relationship to ${invalid.referencedRunId}: `
        + `referenced status is ${invalid.status ?? "missing"}`,
      );
    }

    this.rebuildAgentRunsTable("agent_runs_overloaded_relationship", (priorTable, currentTable) => {
      this.db.exec(`
        INSERT INTO ${currentTable} (
          id, harness, task, cwd, parent_thread_id, model, effort, effort_applied,
          harness_model, harness_effort, harness_identity_observed, depth, status,
          created_at, started_at, finished_at, activity, last_activity_at, child_session_id,
          acpx_record_id, result_tail, error, retry_of_run_id, resume_of_run_id, timeout_seconds
        )
        SELECT
          run.id, run.harness, run.task, run.cwd, run.parent_thread_id, run.model, run.effort,
          run.effort_applied, run.harness_model, run.harness_effort, run.harness_identity_observed,
          run.depth, run.status, run.created_at, run.started_at, run.finished_at, run.activity,
          run.last_activity_at, run.child_session_id, run.acpx_record_id, run.result_tail, run.error,
          CASE WHEN referenced.status IN ('failed','interrupted','lost') THEN run.resume_of_run_id END,
          CASE WHEN referenced.status = 'completed' THEN run.resume_of_run_id END,
          run.timeout_seconds
        FROM ${priorTable} AS run
        LEFT JOIN ${priorTable} AS referenced ON referenced.id = run.resume_of_run_id
      `);
    });
  }

  /** SQLite cannot alter a CHECK constraint. Rebuild only this table, copying every column and
   * recreating its documented indexes; rows and self-referential retry/resume relationships are preserved. */
  private rebuildAgentRunsForCurrentEfforts(): void {
    const columns = (this.db.prepare("PRAGMA table_info(agent_runs)").all() as Array<{ name: string }>)
      .map(({ name }) => name);
    this.rebuildAgentRunsTable("agent_runs_prior_effort_constraint", (priorTable, currentTable) => {
      const names = columns.map((name) => `"${name}"`).join(", ");
      this.db.exec(`INSERT INTO ${currentTable} (${names}) SELECT ${names} FROM ${priorTable}`);
    });
  }

  /** Both agent_runs migrations need SQLite's same fail-closed table-rebuild transaction. */
  private rebuildAgentRunsTable(
    priorTable: "agent_runs_overloaded_relationship" | "agent_runs_prior_effort_constraint",
    copyRows: (priorTable: string, currentTable: string) => void,
  ): void {
    const currentTable = "agent_runs_current";
    const createTable = SCHEMA.match(/CREATE TABLE IF NOT EXISTS agent_runs \([\s\S]*?\n\);/)?.[0];
    const indexes = [...SCHEMA.matchAll(/CREATE INDEX IF NOT EXISTS idx_agent_runs_[\s\S]*?;/g)]
      .map(([sql]) => sql);
    if (!createTable || indexes.length !== 3) throw new Error("agent_runs schema definition is incomplete");
    this.db.exec("PRAGMA foreign_keys = OFF");
    let transactionStarted = false;
    try {
      this.db.exec("BEGIN IMMEDIATE");
      transactionStarted = true;
      for (const index of indexes) {
        const name = /idx_agent_runs_[a-z_]+/.exec(index)?.[0];
        if (name) this.db.exec(`DROP INDEX IF EXISTS ${name}`);
      }
      this.db.exec(`ALTER TABLE agent_runs RENAME TO ${priorTable}`);
      this.db.exec(createTable.replace("agent_runs (", `${currentTable} (`));
      copyRows(priorTable, currentTable);
      this.db.exec(`DROP TABLE ${priorTable}`);
      this.db.exec(`ALTER TABLE ${currentTable} RENAME TO agent_runs`);
      for (const index of indexes) this.db.exec(index);
      const violations = this.db.prepare("PRAGMA foreign_key_check(agent_runs)").all();
      if (violations.length) throw new Error("agent_runs rebuild violated a foreign key");
      this.db.exec("COMMIT");
      transactionStarted = false;
    } catch (error) {
      if (transactionStarted) this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.db.exec("PRAGMA foreign_keys = ON");
    }
  }

  private appendDetailsInTx(
    threadId: string,
    patch: DetailsPatch,
    writtenBy: DetailsRow["writtenBy"],
  ): { version: number; from: ThreadState | null; to: ThreadState } | null {
    const latest = this.latestDetails(threadId);
    const merged = {
      state: patch.state ?? latest?.state ?? "idle",
      priority: "priority" in patch ? patch.priority ?? null : latest?.priority ?? null,
      topic: "topic" in patch ? patch.topic ?? null : latest?.topic ?? null,
      statusSummary: "statusSummary" in patch ? patch.statusSummary ?? null : latest?.statusSummary ?? null,
      bookmark: "bookmark" in patch ? patch.bookmark ?? null : null,
    };
    // A revision is a change of meaning: the lifecycle state, the title, or the status summary.
    // A reassessment that lands on the same understanding, even with a different urgency, keeps
    // the existing revision and the position it was written from.
    if (
      latest && latest.state === merged.state &&
      latest.topic === merged.topic && latest.statusSummary === merged.statusSummary
    ) return null;
    const version = (latest?.version ?? 0) + 1;
    this.db.prepare(
      `INSERT INTO thread_details (
         thread_id, version, created_at, written_by, state,
         priority, topic, status_summary, bookmark_index, bookmark_message_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      threadId, version, this.now(), writtenBy, merged.state,
      merged.priority, merged.topic, merged.statusSummary,
      merged.bookmark?.index ?? null, merged.bookmark?.messageAt ?? null,
    );
    return { version, from: latest?.state ?? null, to: merged.state };
  }

  recordScan(observation: ThreadObservation): RecordScanResult {
    const previous = this.resolutionRow(observation.id);
    if (previous?.lastMessageAt && (!observation.lastMessageAt || observation.lastMessageAt < previous.lastMessageAt)) {
      return { added: false, stateChanged: null };
    }
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
        { state: observation.state },
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
        statusSummary: details.statusSummary ?? null,
      }, "model");
      if (throughMessageAt !== undefined) {
        this.db.prepare("UPDATE threads SET enriched_through_message_at = ?, enrichment_contract = ? WHERE id = ?")
          .run(throughMessageAt, CURRENT_ENRICHMENT_CONTRACT, threadId);
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
    details: ThreadEnrichment,
    throughMessageAt: string,
    children: EnrichmentCandidate["children"] = [],
  ): number | null {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.resolutionRow(threadId);
      const working = current?.state === "working" || this.hasActiveChild(threadId);
      // Guards that reject an assessment: the owner closed the thread, the assessment is not a
      // lifecycle answer, or it was made against evidence that has since moved. A repeat
      // assessment of the same evidence is accepted — it advances the reassessment clock and
      // writes a revision only if the meaning changed.
      if (
        !current || current.state === "done" ||
        (details.attention !== "idle" && details.attention !== "needs-you") ||
        current.lastMessageAt !== throughMessageAt ||
        JSON.stringify(children) !== current.childrenEvidence ||
        (current.enrichedThroughMessageAt ?? "") > throughMessageAt
      ) {
        this.db.exec("COMMIT");
        return null;
      }
      // The title identifies the work, so it holds still while the work stays the same thing:
      // a reworded title for the same task makes the owner re-read a row they already know.
      // Enrichment repeats the current title verbatim unless the task's identity changed
      // categorically, and a different string is what marks that change.
      const currentTitle = this.latestDetails(threadId)?.topic ?? null;
      const edge = this.appendDetailsInTx(threadId, {
        ...(!working ? { state: details.attention } : {}),
        priority: details.priority,
        topic: details.topic || currentTitle,
        statusSummary: details.statusSummary,
        bookmark: details.bookmark ?? null,
      }, "model");
      this.db.prepare(
        `UPDATE threads SET enriched_through_message_at = ?, enriched_while_working = ?,
           enriched_children = ?, enrichment_contract = ?, last_enriched_at = ? WHERE id = ?`,
      ).run(
        throughMessageAt,
        Number(working),
        current.childrenEvidence,
        CURRENT_ENRICHMENT_CONTRACT,
        this.now(),
        threadId,
      );
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
              written_by AS writtenBy, state, priority, topic, status_summary AS statusSummary,
              bookmark_index AS bookmarkIndex, bookmark_message_at AS bookmarkMessageAt
       FROM thread_details WHERE thread_id = ? ORDER BY version DESC LIMIT 1`,
    ).get(threadId) as unknown as DetailsRow | undefined;
  }

  /** Model-written status-summary revisions, newest first. Empty for a thread last assessed
   * under an older contract: those summaries are not offered as an account to keep. */
  statusSummaryHistory(threadId: string, limit: number): StatusSummaryRevision[] {
    return this.db.prepare(
      `SELECT d.version, d.created_at AS createdAt, d.status_summary AS statusSummary, d.bookmark_index AS bookmarkIndex
       FROM thread_details d JOIN threads t ON t.id = d.thread_id
       WHERE d.thread_id = ? AND d.written_by = 'model' AND d.status_summary IS NOT NULL
         AND t.enrichment_contract = ${CURRENT_ENRICHMENT_CONTRACT}
       ORDER BY d.version DESC LIMIT ?`,
    ).all(threadId, limit) as unknown as StatusSummaryRevision[];
  }

  latestDetailsMap(): Map<string, ThreadDetails> {
    const rows = this.db.prepare(
      `SELECT thread_id AS threadId, priority, topic, status_summary AS statusSummary
       FROM thread_details detail
       WHERE version = (SELECT MAX(version) FROM thread_details WHERE thread_id = detail.thread_id)`,
    ).all() as unknown as Array<DetailsRow>;
    return new Map(rows.map((row) => [row.threadId, {
      ...(row.topic != null ? { topic: row.topic } : {}),
      ...(row.statusSummary != null ? { statusSummary: row.statusSummary } : {}),
      ...(row.priority != null ? { priority: row.priority } : {}),
    }]));
  }

  resolutionRow(threadId: string): ThreadResolutionRow | undefined {
    const row = this.db.prepare(
      `SELECT t.id, detail.state, t.last_message_at AS lastMessageAt,
              t.enriched_through_message_at AS enrichedThroughMessageAt,
              t.enriched_while_working AS enrichedWhileWorking,
              t.enriched_children AS enrichedChildren,
              t.enrichment_contract AS enrichmentContract,
              ${CHILD_EVIDENCE_SQL} AS childrenEvidence
       FROM threads t JOIN thread_details detail ON detail.thread_id = t.id
        AND detail.version = (SELECT MAX(version) FROM thread_details WHERE thread_id = t.id)
       WHERE t.id = ?`,
    ).get(threadId) as unknown as ThreadResolutionRow | undefined;
    return row ? { ...row, enrichedWhileWorking: Boolean(row.enrichedWhileWorking) } : undefined;
  }

  listSessionState(options: { activeSince?: string } = {}): SessionStateRow[] {
    const where = options.activeSince
      ? `WHERE ${EFFECTIVE_THREAD_STATE_SQL} != 'done'
           AND (t.last_active_at >= ? OR ${EFFECTIVE_THREAD_STATE_SQL} = 'needs-you'
             OR ${HAS_ACTIVE_CHILD_SQL})`
      : `WHERE ${EFFECTIVE_THREAD_STATE_SQL} != 'done'`;
    const statement = this.db.prepare(
      `SELECT t.id, COALESCE(t.source, '') AS source,
              COALESCE(selected_worktree.repository, t.repo, '') AS repo,
              COALESCE(selected_worktree.path, t.project) AS project,
              COALESCE(t.app, '') AS app,
              COALESCE(t.owner_title, detail.topic, t.raw_topic, '') AS topic,
              COALESCE(detail.topic, '') AS generatedTopic, t.owner_title AS ownerTitle,
              detail.status_summary AS statusSummary,
              CASE WHEN t.enriched_through_message_at = t.last_message_at
                     AND t.enriched_children = ${CHILD_EVIDENCE_SQL}
                     AND t.enriched_while_working = (${EFFECTIVE_THREAD_STATE_SQL} = 'working')
                     AND t.enrichment_contract = ${CURRENT_ENRICHMENT_CONTRACT}
                   THEN 0 ELSE 1 END AS statusSummaryPending, detail.priority,
              ${EFFECTIVE_THREAD_STATE_SQL} AS state,
              detail.created_at AS stateSince,
              t.last_active_at AS lastActiveAt,
              t.created_at AS createdAt, t.last_message_at AS lastMessageAt,
              t.diff_added AS diffAdded, t.diff_deleted AS diffDeleted,
              (SELECT run.parent_thread_id FROM agent_runs run
                WHERE run.child_session_id = t.id AND run.parent_thread_id IS NOT NULL
                ORDER BY run.created_at DESC LIMIT 1) AS parentThreadId
       FROM threads t JOIN thread_details detail ON detail.thread_id = t.id
        AND detail.version = (SELECT MAX(version) FROM thread_details WHERE thread_id = t.id)
       LEFT JOIN thread_worktrees selection ON selection.thread_id = t.id
       LEFT JOIN worktrees selected_worktree ON selected_worktree.id = selection.worktree_id
       ${where}
       -- Rows sit where they were born: a session's place never changes with its state or its
       -- latest message, so the owner's eye can return to it. New work enters at the top.
       ORDER BY COALESCE(t.created_at, t.last_message_at) DESC, t.id`,
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
        statusSummaryPending: Boolean(row.statusSummaryPending),
        lastActive: row.lastMessageAt ? formatRelative((nowMs - Date.parse(row.lastMessageAt)) / 1000) : "",
      }));
  }

  listEnrichmentCandidates(): EnrichmentCandidate[] {
    const reassessWorkingBefore = new Date(Date.parse(this.now()) - WORKING_REASSESS_MS).toISOString();
    const ids = this.db.prepare(
      `SELECT t.id FROM threads t JOIN thread_details detail ON detail.thread_id = t.id
        AND detail.version = (SELECT MAX(version) FROM thread_details WHERE thread_id = t.id)
       WHERE detail.state IN ('needs-you', 'idle', 'working') AND t.last_message_at IS NOT NULL
         AND (t.enriched_through_message_at IS NULL OR t.enriched_through_message_at < t.last_message_at
           OR t.enrichment_contract != ${CURRENT_ENRICHMENT_CONTRACT}
           OR t.enriched_children != ${CHILD_EVIDENCE_SQL}
           OR (t.enriched_through_message_at = t.last_message_at
             AND t.enriched_while_working != (${EFFECTIVE_THREAD_STATE_SQL} = 'working'))
           -- A long turn writes no message for minutes while the owner reads that row, so a
           -- working session is reassessed on a cadence instead of waiting for the turn to end.
           OR (${EFFECTIVE_THREAD_STATE_SQL} = 'working'
             AND (t.last_enriched_at IS NULL OR t.last_enriched_at <= ?)))
       -- Enrichment takes candidates in this order, so it is what the owner waits on. A row
       -- with no title yet is showing raw prompt text, so it goes before rows that are only
       -- refreshing a title they already have; within each group, newest work first.
       ORDER BY (COALESCE(t.owner_title, detail.topic) IS NOT NULL) ASC, t.last_message_at DESC`,
    ).all(reassessWorkingBefore) as Array<{ id: string }>;
    const rows = new Map(this.listSessionState().map((row) => [row.id, row]));
    return ids.flatMap(({ id }) => {
      const row = rows.get(id);
      const resolution = this.resolutionRow(id);
      return row ? [{
        ...row,
        enrichedThroughMessageAt: resolution?.enrichedThroughMessageAt ?? null,
        children: JSON.parse(resolution?.childrenEvidence ?? "[]") as EnrichmentCandidate["children"],
      }] : [];
    });
  }

  requestEnrichment(requests: readonly { id: string; lastMessageAt: string }[]): string[] {
    const reset = this.db.prepare(`UPDATE threads AS t SET enriched_through_message_at = NULL
      WHERE t.id = ? AND t.last_message_at = ?
        AND (SELECT state FROM thread_details WHERE thread_id = t.id ORDER BY version DESC LIMIT 1) IN ('idle', 'needs-you', 'working')`);
    return requests.flatMap(({ id, lastMessageAt }) => Number(reset.run(id, lastMessageAt).changes) ? [id] : []);
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
         id, harness, task, cwd, parent_thread_id, model, effort, depth, status, created_at,
         child_session_id, acpx_record_id, retry_of_run_id, resume_of_run_id, timeout_seconds
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      insert.id, insert.harness, insert.task, insert.cwd, insert.parentThreadId ?? null,
      insert.model ?? null, insert.effort ?? null, insert.depth, AgentRunStatus.Pending, this.now(),
      insert.childSessionId ?? null, insert.acpxRecordId ?? null,
      insert.retryOfRunId ?? null, insert.resumeOfRunId ?? null, insert.timeoutSeconds,
    );
    return this.agentRunById(insert.id)!;
  }

  /** The most recent run whose child session equals this id — the depth-guard and monitor-join
   * lookup. A thread that is some run's child cannot itself be a delegating parent at depth 1. */
  agentRunByChildSession(childSessionId: string): AgentRun | undefined {
    const row = this.db.prepare(
      `SELECT ${AGENT_RUN_COLUMNS} FROM agent_runs
       WHERE child_session_id = ? ORDER BY created_at DESC LIMIT 1`,
    ).get(childSessionId) as unknown as AgentRunDbRow | undefined;
    return toAgentRun(row);
  }

  /** A pending-or-running run for this child session, if any — the Retry/Resume active-child guard. */
  nonterminalAgentRunByChildSession(childSessionId: string): AgentRun | undefined {
    const row = this.db.prepare(
      `SELECT ${AGENT_RUN_COLUMNS} FROM agent_runs
       WHERE child_session_id = ? AND status IN (?, ?)
       ORDER BY created_at DESC LIMIT 1`,
    ).get(childSessionId, AgentRunStatus.Pending, AgentRunStatus.Running) as unknown as AgentRunDbRow | undefined;
    return toAgentRun(row);
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
  recordAgentRunActivity(id: string, update: AgentRunActivityUpdate): AgentRun | null {
    const identity = update.harnessIdentity === undefined
      ? undefined
      : harnessIdentityObservation({
          model: update.harnessIdentity.observed ? update.harnessIdentity.model : undefined,
          effort: update.harnessIdentity.observed ? update.harnessIdentity.effort : undefined,
        });
    const changed = Number(this.db.prepare(
      `UPDATE agent_runs SET
         activity = COALESCE(?, activity),
         last_activity_at = ?,
         child_session_id = COALESCE(?, child_session_id),
         acpx_record_id = COALESCE(?, acpx_record_id),
         effort_applied = COALESCE(?, effort_applied),
         harness_model = CASE WHEN ? IS NULL THEN harness_model ELSE ? END,
         harness_effort = CASE WHEN ? IS NULL THEN harness_effort ELSE ? END,
         harness_identity_observed = COALESCE(?, harness_identity_observed)
       WHERE id = ? AND status = ?`,
    ).run(
      update.activity ?? null, this.now(), update.childSessionId ?? null,
      update.acpxRecordId ?? null,
      update.effortApplied === undefined ? null : Number(update.effortApplied),
      identity === undefined ? null : Number(identity.observed), identity?.observed ? identity.model ?? null : null,
      identity === undefined ? null : Number(identity.observed), identity?.observed ? identity.effort ?? null : null,
      identity === undefined ? null : Number(identity.observed),
      id, AgentRunStatus.Running,
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
    if (!changed) return null;
    const run = this.agentRunById(id)!;
    this.appendResultRecord(run);
    return run;
  }

  markRunningAgentRunsInterrupted(reason: string): string[] {
    const ids = (this.db.prepare(
      "SELECT id FROM agent_runs WHERE status = ? ORDER BY created_at ASC",
    ).all(AgentRunStatus.Running) as Array<{ id: string }>).map((row) => row.id);
    if (ids.length) {
      this.db.prepare(
        "UPDATE agent_runs SET status = ?, finished_at = ?, error = ? WHERE status = ?",
      ).run(AgentRunStatus.Interrupted, this.now(), reason, AgentRunStatus.Running);
      for (const id of ids) this.appendResultRecord(this.agentRunById(id)!);
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
      this.appendResultRecord(this.agentRunById(id)!);
    }
    return stale;
  }

  /** Append one child stream event while the run is running; returns its sequence number. */
  appendAgentRunEvent(runId: string, event: AgentRunStreamEvent): number | null {
    const running = this.db.prepare("SELECT 1 FROM agent_runs WHERE id = ? AND status = ?")
      .get(runId, AgentRunStatus.Running);
    if (!running) return null;
    const seq = this.insertLogRecord(runId, event);
    this.enforceEventLogBudget(runId);
    return seq;
  }

  /** The run's log after `afterSeq`, in order. The final entry is the terminal record once written. */
  agentRunEvents(runId: string, afterSeq = 0): AgentRunLogEntry[] {
    return (this.db.prepare(
      "SELECT seq, at, record FROM agent_run_events WHERE run_id = ? AND seq > ? ORDER BY seq",
    ).all(runId, afterSeq) as Array<{ seq: number; at: string; record: string }>)
      .map((row) => ({ seq: row.seq, at: row.at, record: JSON.parse(row.record) as AgentRunLogRecord }));
  }

  private appendResultRecord(run: AgentRun): void {
    const record: AgentRunResultRecord = {
      type: "result",
      runId: run.id,
      status: run.status,
      ...(run.error ? { error: { message: run.error } } : {}),
    };
    this.insertLogRecord(run.id, record);
  }

  private insertLogRecord(runId: string, record: AgentRunLogRecord): number {
    const text = JSON.stringify(record);
    const bytes = Buffer.byteLength(text);
    const { seq } = this.db.prepare(
      `INSERT INTO agent_run_events (run_id, seq, at, record, bytes)
       VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM agent_run_events WHERE run_id = ?), ?, ?, ?)
       RETURNING seq`,
    ).get(runId, runId, this.now(), text, bytes) as { seq: number };
    const known = this.eventLogBytes.get(runId);
    if (known !== undefined) this.eventLogBytes.set(runId, known + bytes);
    return seq;
  }

  private enforceEventLogBudget(runId: string): void {
    let total = this.eventLogBytes.get(runId);
    if (total === undefined) {
      total = (this.db.prepare("SELECT COALESCE(SUM(bytes), 0) AS total FROM agent_run_events WHERE run_id = ?")
        .get(runId) as { total: number }).total;
      this.eventLogBytes.set(runId, total);
    }
    if (total <= this.eventLogMaxBytes) return;
    const oldest = this.db.prepare(
      "SELECT seq, bytes FROM agent_run_events WHERE run_id = ? ORDER BY seq",
    ).iterate(runId) as Iterable<{ seq: number; bytes: number }>;
    let through = 0;
    for (const row of oldest) {
      if (total <= this.eventLogMaxBytes) break;
      total -= row.bytes;
      through = row.seq;
    }
    this.db.prepare("DELETE FROM agent_run_events WHERE run_id = ? AND seq <= ?").run(runId, through);
    this.eventLogBytes.set(runId, total);
  }

  agentRunById(id: string): AgentRun | undefined {
    const row = this.db.prepare(
      `SELECT ${AGENT_RUN_COLUMNS} FROM agent_runs WHERE id = ?`,
    ).get(id) as unknown as AgentRunDbRow | undefined;
    return toAgentRun(row);
  }

  listAgentRuns(filter: { parentThreadId?: string } = {}): AgentRun[] {
    const sql = `SELECT ${AGENT_RUN_COLUMNS} FROM agent_runs
                 ${filter.parentThreadId !== undefined ? "WHERE parent_thread_id = ?" : ""}
                 ORDER BY created_at DESC, rowid DESC`;
    const statement = this.db.prepare(sql);
    const rows = (
      filter.parentThreadId !== undefined ? statement.all(filter.parentThreadId) : statement.all()
    ) as unknown as AgentRunDbRow[];
    return rows.map((row) => toAgentRun(row)!);
  }

  /** Register creation provenance and replace the root's selection in one SQLite transaction.
   * An existing exact path is reused only when its immutable repository identity agrees. */
  registerAndSelectWorktree(
    threadId: string,
    worktree: RegisteredWorktree,
    selectedAt: string,
  ): RegisteredWorktree {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.worktreeByPath(worktree.path);
      if (existing) {
        if (existing.repository !== worktree.repository || existing.gitCommonDir !== worktree.gitCommonDir) {
          throw new Error(`registered worktree identity conflicts at ${worktree.path}`);
        }
      } else {
        this.db.prepare(
          `INSERT INTO worktrees (
             id, repository, path, git_common_dir, created_by_thread_id, created_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(
          worktree.id,
          worktree.repository,
          worktree.path,
          worktree.gitCommonDir,
          worktree.createdByThreadId,
          worktree.createdAt,
        );
      }
      const selected = existing ?? worktree;
      this.upsertWorktreeSelection(threadId, selected.id, selectedAt);
      this.db.exec("COMMIT");
      return selected;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  selectWorktree(threadId: string, worktreeId: string, selectedAt: string): RegisteredWorktree {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const worktree = this.worktreeById(worktreeId);
      if (!worktree) throw new Error(`worktree not found: ${worktreeId}`);
      this.upsertWorktreeSelection(threadId, worktreeId, selectedAt);
      this.db.exec("COMMIT");
      return worktree;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  worktreeById(id: string): RegisteredWorktree | undefined {
    return this.db.prepare(`SELECT ${WORKTREE_COLUMNS} FROM worktrees WHERE id = ?`)
      .get(id) as unknown as RegisteredWorktree | undefined;
  }

  selectedWorktree(threadId: string): RegisteredWorktree | undefined {
    return this.db.prepare(
      `SELECT ${JOINED_WORKTREE_COLUMNS}
       FROM thread_worktrees selection
       JOIN worktrees w ON w.id = selection.worktree_id
       WHERE selection.thread_id = ?`,
    ).get(threadId) as unknown as RegisteredWorktree | undefined;
  }

  listWorktrees(repository?: string): RegisteredWorktree[] {
    const statement = this.db.prepare(
      `SELECT ${WORKTREE_COLUMNS} FROM worktrees
       ${repository === undefined ? "" : "WHERE repository = ?"}
       ORDER BY created_at ASC, id ASC`,
    );
    return (repository === undefined ? statement.all() : statement.all(repository)) as unknown as RegisteredWorktree[];
  }

  private worktreeByPath(path: string): RegisteredWorktree | undefined {
    return this.db.prepare(`SELECT ${WORKTREE_COLUMNS} FROM worktrees WHERE path = ?`)
      .get(path) as unknown as RegisteredWorktree | undefined;
  }

  private upsertWorktreeSelection(threadId: string, worktreeId: string, selectedAt: string): void {
    this.db.prepare(
      `INSERT INTO thread_worktrees (thread_id, worktree_id, selected_at)
       VALUES (?, ?, ?)
       ON CONFLICT(thread_id) DO UPDATE SET
         worktree_id = excluded.worktree_id, selected_at = excluded.selected_at`,
    ).run(threadId, worktreeId, selectedAt);
  }

  private hasActiveChild(threadId: string): boolean {
    return Boolean(this.db.prepare(
      `SELECT 1 FROM threads t WHERE t.id = ? AND ${HAS_ACTIVE_CHILD_SQL}`,
    ).get(threadId));
  }

  listNeedsYouMessageVersions(): Array<{ threadId: string; lastMessageAt: string }> {
    return this.db.prepare(
      `SELECT t.id AS threadId, t.last_message_at AS lastMessageAt
       FROM threads t JOIN thread_details detail ON detail.thread_id = t.id
        AND detail.version = (SELECT MAX(version) FROM thread_details WHERE thread_id = t.id)
       WHERE detail.state = 'needs-you' AND t.last_message_at IS NOT NULL
         AND NOT ${HAS_ACTIVE_CHILD_SQL}
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
      const eligible = this.db.prepare(
        `SELECT 1 FROM threads t JOIN thread_details detail ON detail.thread_id = t.id
          AND detail.version = (SELECT MAX(version) FROM thread_details WHERE thread_id = t.id)
         WHERE t.id = ? AND t.last_message_at = ? AND detail.state = 'needs-you'
           AND NOT ${HAS_ACTIVE_CHILD_SQL}`,
      );
      const fresh = params.changes.filter((change) => {
        if (!eligible.get(change.threadId, change.lastMessageAt)) return false;
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
