// Owner Operator — durable thread db. The SQLite engine behind store.ts's seam: where the
// JSON export keeps only the LATEST snapshot, this keeps history. node:sqlite,
// dependency-free.
//
// THE MODEL — identity vs observation vs belief:
//   threads         — one mutable row per thread: identity (who/where) plus live
//                     observation (activity timestamps, poll-window membership, diff
//                     counts). Facts the transcript gives us for free; never the model's.
//   thread_details  — append-only versioned ledger of what we BELIEVE about a thread:
//                     state + the model's enrichment (topic/summary/next_steps/priority).
//                     The LATEST version is the current truth; the full history is the
//                     audit trail ("one thread's story" = SELECT … ORDER BY version).
//                     Rows are DENSE: every version carries all fields (carry-forward on
//                     append), so any row is self-contained. Versions land only on
//                     semantic change — activity ticks never touch this table.
//   meta            — store-level keys (polled_at = the current snapshot's timestamp)
//
// Column-level documentation lives in schema-docs.ts — the agent-facing schema doc the
// query_database tool serves. It is a PROMPT SURFACE: update it with any schema change.
//
// MULTI-CONSUMER WRITING — why concurrent writer processes (widget + headless oo + future
// widget/web) are safe here, and the rules any NEW writer must follow:
//   • WAL + busy_timeout(5s): readers never block the writer; a second writer queues
//     briefly instead of throwing SQLITE_BUSY on first collision.
//   • Every logical mutation is ONE `BEGIN IMMEDIATE` transaction. Never read-then-write
//     across two transactions — that reintroduces the last-writer-wins clobber.
//   • ALL thread_details writes go through appendDetailsInTx — the one guarded append.
//     It numbers the version, carries forward the fields the writer doesn't own, dedups
//     no-op writes, and re-applies the canonical done-hold (a transcription of
//     holdsDone(), packages/core/src/resolve.mjs — keep the two in lockstep) so a writer
//     holding a stale snapshot cannot resurrect an owner-set `done`. A new "rebuild the
//     world" writer must go through saveSnapshot, never raw INSERTs into thread_details.
//   • Change events here are in-process only. Cross-process push is the daemon's job
//     (daemon.ts — openclaw's gateway pattern): it owns the poll loop and broadcasts
//     snapshots/edges over SSE. A consumer without the daemon reads the derived
//     status.json (see store.ts) or queries the db read-only and watches the -wal file +
//     PRAGMA data_version.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  STATE_RANK,
  formatRelative,
  type Schedule,
  type ScheduleAction,
  type ScheduleWhen,
  type StatusSnapshot,
  type ThreadState,
  type ThreadStatus,
  type ThreadDetails,
} from "@owner-operator/core";
import { STORE_DIR } from "./store";

/** Machine-global like the JSON store — threads span every repo on the box. */
export function defaultDbPath(): string {
  return join(STORE_DIR, "threads.db");
}

const isThreadState = (s: string): s is ThreadState => s in STATE_RANK;

/** One thread as seen by a poll pass. Omitted identity fields keep their stored value. */
export interface ThreadObservation {
  id: string;
  repo?: string;
  app?: string;
  source?: string;
  transcriptPath?: string;
  /** ISO timestamps (absolute — surfaces relativize for display). */
  createdAt?: string;
  lastActiveAt?: string;
  rawTopic?: string;
  state: ThreadState;
  stateReason?: string;
  lastAssistantAt?: string;
  lastUserAt?: string;
}

/** Who appended a details version — the one provenance field audits actually use. */
export type DetailsWriter = "poll" | "model" | "owner" | "migration";

/**
 * A partial belief update. Only the keys PRESENT are the writer's claim; absent keys
 * carry forward from the latest version (dense rows). Present-but-null clears the field.
 */
export interface DetailsPatch {
  state?: ThreadState;
  stateReason?: string | null;
  priority?: number | null;
  topic?: string | null;
  summary?: string | null;
  nextSteps?: string | null;
}

/** One version of the belief ledger, self-contained (dense). */
export interface DetailsRow {
  threadId: string;
  version: number;
  createdAt: string;
  writtenBy: DetailsWriter;
  state: ThreadState;
  stateReason: string | null;
  priority: number | null;
  topic: string | null;
  summary: string | null;
  nextSteps: string | null;
}

/** The session-state projection: identity + latest details, one row per active thread. */
export interface SessionStateRow {
  id: string;
  source: string;
  repo: string;
  app: string;
  topic: string;
  generatedTopic: string;
  ownerTitle: string | null;
  summary: string | null;
  nextSteps: string | null;
  priority: number | null;
  state: ThreadState;
  stateReason: string | null;
  lastActive: string;
  lastActiveAt: string | null;
  createdAt: string | null;
  lastMessageAt: string | null;
  diffAdded: number | null;
  diffDeleted: number | null;
}

/** Change events, emitted post-commit. Edges, not snapshots — same idea as StatusDiff. */
export type ThreadDbEvent =
  | { type: "thread_added"; threadId: string; state: ThreadState }
  | { type: "state_changed"; threadId: string; from: ThreadState; to: ThreadState; reason: string | null }
  | { type: "details_updated"; threadId: string; version: number };

export interface RecordScanResult {
  added: boolean;
  stateChanged: { from: ThreadState; to: ThreadState } | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS threads (
  id                TEXT PRIMARY KEY,
  repo              TEXT,
  project           TEXT,
  app               TEXT,
  source            TEXT,
  transcript_path   TEXT,
  created_at        TEXT,
  first_seen_at     TEXT NOT NULL,
  -- live observation (mutable in place; see thread_details for versioned belief)
  last_seen_at      TEXT NOT NULL,
  last_active_at    TEXT,
  last_message_at   TEXT,
  last_assistant_at TEXT,
  last_user_at      TEXT,
  last_checked_at   TEXT,
  in_snapshot       INTEGER NOT NULL DEFAULT 0,
  diff_added        INTEGER,
  diff_deleted      INTEGER,
  raw_topic         TEXT,
  owner_title       TEXT
);

CREATE INDEX IF NOT EXISTS idx_threads_in_snapshot ON threads(in_snapshot);

CREATE TABLE IF NOT EXISTS thread_details (
  thread_id    TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  version      INTEGER NOT NULL,
  created_at   TEXT NOT NULL,
  written_by   TEXT NOT NULL
               CHECK (written_by IN ('poll', 'model', 'owner', 'migration')),
  state        TEXT NOT NULL
               CHECK (state IN ('needs-you', 'working', 'idle', 'done')),
  state_reason TEXT,
  priority     INTEGER,
  topic        TEXT,
  summary      TEXT,
  next_steps   TEXT,
  PRIMARY KEY (thread_id, version)
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schedules (
  name             TEXT PRIMARY KEY,
  when_json        TEXT NOT NULL,
  action_json      TEXT NOT NULL,
  enabled          INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL,
  last_run_at      TEXT,
  last_result_json TEXT
);
`;

/** Columns the rebuild keeps, in threads-table order. Shared by migration DDL + copy. */
const THREAD_COLS =
  "id, repo, project, app, source, transcript_path, created_at, first_seen_at, " +
  "last_seen_at, last_active_at, last_message_at, last_assistant_at, last_user_at, " +
  "last_checked_at, in_snapshot, diff_added, diff_deleted, raw_topic, owner_title";

export class ThreadDb {
  private db: DatabaseSync;
  private now: () => string;
  private listeners = new Set<(e: ThreadDbEvent) => void>();

  constructor(dbPath: string = defaultDbPath(), opts: { now?: () => string } = {}) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.now = opts.now ?? (() => new Date().toISOString());
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    // Multiple surfaces can hold the db at once; wait briefly instead of
    // throwing SQLITE_BUSY on the first collision.
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec(SCHEMA);
    this.migrateLegacy();
  }

  /**
   * THROWAWAY migration (2026-07): dbs from before the thread_details ledger carried
   * state/triage split across a mutable `threads` and a `thread_triage` table. Detect by
   * the old `state` column; seed each thread's details version 1 from current truth
   * (threads row + its latest triage), then rebuild `threads` without the moved/dead
   * columns. `thread_triage` stays in place read-only — pre-cutover history was never
   * paired with state, so backfilling it into the dense ledger would fabricate data.
   * Delete this method once every db on the box has crossed over.
   */
  private migrateLegacy(): void {
    const cols = new Set(
      (this.db.prepare("PRAGMA table_info(threads)").all() as Array<{ name: string }>).map((c) => c.name),
    );
    if (!cols.has("state")) return; // already the ledger shape
    // Ancient dbs may predate some kept columns — add them so the rebuild copy is total.
    for (const ddl of [
      "project TEXT", "transcript_path TEXT", "last_message_at TEXT",
      "last_assistant_at TEXT", "last_user_at TEXT", "last_checked_at TEXT",
      "in_snapshot INTEGER NOT NULL DEFAULT 0", "diff_added INTEGER",
      "diff_deleted INTEGER", "owner_title TEXT",
    ]) {
      if (!cols.has(ddl.split(" ")[0])) this.db.exec(`ALTER TABLE threads ADD COLUMN ${ddl}`);
    }
    const hasTriage = !!this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'thread_triage'")
      .get();
    // FK off for the table swap: with enforcement on, DROP TABLE threads would CASCADE
    // the just-seeded details (and the legacy triage history) away.
    this.db.exec("PRAGMA foreign_keys = OFF");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const seed = hasTriage
        ? `INSERT INTO thread_details (thread_id, version, created_at, written_by,
             state, state_reason, priority, topic, summary, next_steps)
           SELECT t.id, 1, ?, 'migration', t.state, t.state_reason,
                  g.priority, g.topic, g.summary, g.next_steps
           FROM threads t
           LEFT JOIN thread_triage g
             ON g.thread_id = t.id
            AND g.version = (SELECT MAX(version) FROM thread_triage WHERE thread_id = t.id)
           WHERE NOT EXISTS (SELECT 1 FROM thread_details d WHERE d.thread_id = t.id)`
        : `INSERT INTO thread_details (thread_id, version, created_at, written_by, state, state_reason)
           SELECT t.id, 1, ?, 'migration', t.state, t.state_reason
           FROM threads t
           WHERE NOT EXISTS (SELECT 1 FROM thread_details d WHERE d.thread_id = t.id)`;
      this.db.prepare(seed).run(this.now());
      this.db.exec(`CREATE TABLE threads_v2 (
        id                TEXT PRIMARY KEY,
        repo              TEXT,
        project           TEXT,
        app               TEXT,
        source            TEXT,
        transcript_path   TEXT,
        created_at        TEXT,
        first_seen_at     TEXT NOT NULL,
        last_seen_at      TEXT NOT NULL,
        last_active_at    TEXT,
        last_message_at   TEXT,
        last_assistant_at TEXT,
        last_user_at      TEXT,
        last_checked_at   TEXT,
        in_snapshot       INTEGER NOT NULL DEFAULT 0,
        diff_added        INTEGER,
        diff_deleted      INTEGER,
        raw_topic         TEXT,
        owner_title       TEXT
      )`);
      this.db.exec(`INSERT INTO threads_v2 (${THREAD_COLS}) SELECT ${THREAD_COLS} FROM threads`);
      this.db.exec("DROP TABLE threads");
      this.db.exec("ALTER TABLE threads_v2 RENAME TO threads");
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_threads_in_snapshot ON threads(in_snapshot)");
      this.db.exec("COMMIT");
    } catch (err) {
      // Restore FK enforcement even if ROLLBACK itself throws (e.g. SQLite already
      // auto-rolled-back) — otherwise the pragma below is skipped and the connection
      // keeps FK off.
      try { this.db.exec("ROLLBACK"); } catch { /* may have auto-rolled-back */ }
      this.db.exec("PRAGMA foreign_keys = ON");
      throw err;
    }
    this.db.exec("PRAGMA foreign_keys = ON");
  }

  subscribe(listener: (e: ThreadDbEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(e: ThreadDbEvent): void {
    for (const l of this.listeners) l(e);
  }

  /**
   * THE ONE GUARDED APPEND — every thread_details write lands here, inside the caller's
   * open transaction. Dense carry-forward: keys present in `patch` are the writer's
   * claim; absent keys copy from the latest version. Identical-to-latest merges are
   * dropped (no version churn), so versions land only on semantic change.
   *
   * DONE-HOLD (the write-boundary backstop, cross-process edition of holdsDone() in
   * packages/core/src/resolve.mjs — keep in lockstep): when `holdIfNotNewerThan` is
   * given (the thread's STORED last_message_at, read before the caller updates it), a
   * non-owner writer whose observation isn't strictly newer cannot move a `done` thread
   * off done — a stale snapshot can't resurrect a resolved thread. Owner writes bypass
   * the hold: `done` is owner state, the owner can always set or unset it.
   *
   * Returns the appended edge, or null when the write was a no-op.
   */
  private appendDetailsInTx(
    threadId: string,
    patch: DetailsPatch,
    writtenBy: DetailsWriter,
    opts: { observedLastMessageAt?: string | null; holdIfNotNewerThan?: string | null } = {},
  ): { version: number; from: ThreadState | null; to: ThreadState } | null {
    const latest = this.db.prepare(
      `SELECT version, state, state_reason AS stateReason, priority, topic, summary,
              next_steps AS nextSteps
       FROM thread_details WHERE thread_id = ? ORDER BY version DESC LIMIT 1`,
    ).get(threadId) as
      | { version: number; state: ThreadState; stateReason: string | null; priority: number | null; topic: string | null; summary: string | null; nextSteps: string | null }
      | undefined;

    let state = patch.state ?? latest?.state ?? "idle";
    if (
      writtenBy !== "owner" && latest?.state === "done" && state !== "done" &&
      opts.holdIfNotNewerThan != null && opts.observedLastMessageAt != null &&
      opts.observedLastMessageAt <= opts.holdIfNotNewerThan
    ) {
      state = "done";
    }
    // state_reason: a state CHANGE always overwrites it (a stale reason on a new state
    // is worse than none); a steady-state write keeps the stored reason unless the
    // patch brings a fresh claim.
    const changed = state !== (latest?.state ?? null);
    const stateReason =
      patch.stateReason !== undefined ? patch.stateReason : changed ? null : latest?.stateReason ?? null;
    const merged = {
      state,
      stateReason,
      priority: "priority" in patch ? patch.priority ?? null : latest?.priority ?? null,
      topic: "topic" in patch ? patch.topic ?? null : latest?.topic ?? null,
      summary: "summary" in patch ? patch.summary ?? null : latest?.summary ?? null,
      nextSteps: "nextSteps" in patch ? patch.nextSteps ?? null : latest?.nextSteps ?? null,
    };
    if (
      latest && merged.state === latest.state && merged.stateReason === latest.stateReason &&
      merged.priority === latest.priority && merged.topic === latest.topic &&
      merged.summary === latest.summary && merged.nextSteps === latest.nextSteps
    ) {
      return null;
    }
    const version = (latest?.version ?? 0) + 1;
    this.db.prepare(
      `INSERT INTO thread_details (thread_id, version, created_at, written_by,
         state, state_reason, priority, topic, summary, next_steps)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      threadId, version, this.now(), writtenBy,
      merged.state, merged.stateReason, merged.priority, merged.topic,
      merged.summary, merged.nextSteps,
    );
    return { version, from: latest?.state ?? null, to: merged.state };
  }

  /** Upsert one poll observation. Detects the state edge and emits events post-commit. */
  recordScan(obs: ThreadObservation): RecordScanResult {
    if (!isThreadState(obs.state)) throw new Error(`invalid thread state: ${obs.state}`);
    const now = this.now();
    const events: ThreadDbEvent[] = [];
    let result: RecordScanResult;

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const prev = this.db.prepare("SELECT id FROM threads WHERE id = ?").get(obs.id);
      if (!prev) {
        this.db.prepare(
          `INSERT INTO threads (id, repo, app, source, transcript_path, created_at,
             last_active_at, first_seen_at, last_seen_at, raw_topic,
             last_assistant_at, last_user_at, last_checked_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          obs.id, obs.repo ?? null, obs.app ?? null, obs.source ?? null,
          obs.transcriptPath ?? null, obs.createdAt ?? null, obs.lastActiveAt ?? null,
          now, now, obs.rawTopic ?? null,
          obs.lastAssistantAt ?? null, obs.lastUserAt ?? null, now,
        );
      } else {
        // COALESCE keeps stored identity when the observation omits a field.
        this.db.prepare(
          `UPDATE threads SET
             repo = COALESCE(?, repo), app = COALESCE(?, app), source = COALESCE(?, source),
             transcript_path = COALESCE(?, transcript_path),
             created_at = COALESCE(?, created_at),
             last_active_at = COALESCE(?, last_active_at),
             raw_topic = COALESCE(?, raw_topic),
             last_seen_at = ?,
             last_assistant_at = COALESCE(?, last_assistant_at),
             last_user_at = COALESCE(?, last_user_at),
             last_checked_at = ?
           WHERE id = ?`,
        ).run(
          obs.repo ?? null, obs.app ?? null, obs.source ?? null,
          obs.transcriptPath ?? null, obs.createdAt ?? null, obs.lastActiveAt ?? null,
          obs.rawTopic ?? null,
          now,
          obs.lastAssistantAt ?? null, obs.lastUserAt ?? null,
          now, obs.id,
        );
      }
      // recordScan callers resolve state through resolveCandidates (which already ran
      // holdsDone against persisted state), so the observation's state is authoritative
      // here — no hold, matching the pre-ledger behavior.
      const edge = this.appendDetailsInTx(
        obs.id,
        { state: obs.state, ...(obs.stateReason !== undefined ? { stateReason: obs.stateReason } : {}) },
        "poll",
      );
      // details_updated first; the headline edge event (added/changed) closes the batch.
      if (edge) events.push({ type: "details_updated", threadId: obs.id, version: edge.version });
      if (!prev) {
        events.push({ type: "thread_added", threadId: obs.id, state: obs.state });
        result = { added: true, stateChanged: null };
      } else if (edge && edge.from !== null && edge.from !== edge.to) {
        events.push({
          type: "state_changed", threadId: obs.id,
          from: edge.from, to: edge.to, reason: obs.stateReason ?? null,
        });
        result = { added: false, stateChanged: { from: edge.from, to: edge.to } };
      } else {
        result = { added: false, stateChanged: null };
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }

    for (const e of events) this.emit(e);
    return result;
  }

  /**
   * Model enrichment append (where model-written details land): the model owns
   * topic/summary/next_steps/priority — all four are its claim on every write (absent =
   * cleared), state carries forward. Identical claims are dropped, so re-saving the
   * whole enrichment map stays version-stable. Unknown thread ids get a stub row
   * (in_snapshot = 0 → invisible to snapshots until a poll sees them) so the FK holds
   * and a pre-poll enrichment isn't lost. Returns the new version, or null if unchanged.
   */
  appendModelDetails(threadId: string, t: ThreadDetails): number | null {
    const now = this.now();
    let edge: { version: number } | null = null;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(
        "INSERT OR IGNORE INTO threads (id, first_seen_at, last_seen_at) VALUES (?, ?, ?)",
      ).run(threadId, now, now);
      edge = this.appendDetailsInTx(
        threadId,
        {
          priority: t.priority ?? null, topic: t.topic ?? null,
          summary: t.summary ?? null, nextSteps: t.nextSteps ?? null,
        },
        "model",
      );
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    if (edge) this.emit({ type: "details_updated", threadId, version: edge.version });
    return edge?.version ?? null;
  }

  /** Latest ledger version for one thread — current belief, self-contained. */
  latestDetails(threadId: string): DetailsRow | undefined {
    return this.db.prepare(
      `SELECT thread_id AS threadId, version, created_at AS createdAt,
              written_by AS writtenBy, state, state_reason AS stateReason,
              priority, topic, summary, next_steps AS nextSteps
       FROM thread_details WHERE thread_id = ?
       ORDER BY version DESC LIMIT 1`,
    ).get(threadId) as DetailsRow | undefined;
  }

  /** Latest enrichment per thread, as the cache map joined into session state by id. */
  latestDetailsMap(): Map<string, ThreadDetails> {
    const rows = this.db.prepare(
      `SELECT thread_id AS threadId, priority, topic, summary, next_steps AS nextSteps
       FROM thread_details x
       WHERE version = (SELECT MAX(version) FROM thread_details WHERE thread_id = x.thread_id)`,
    ).all() as Array<{ threadId: string; priority: number | null; topic: string | null; summary: string | null; nextSteps: string | null }>;
    const map = new Map<string, ThreadDetails>();
    for (const r of rows) {
      map.set(r.threadId, {
        ...(r.topic != null ? { topic: r.topic } : {}),
        ...(r.summary != null ? { summary: r.summary } : {}),
        ...(r.nextSteps != null ? { nextSteps: r.nextSteps } : {}),
        ...(r.priority != null ? { priority: r.priority } : {}),
      });
    }
    return map;
  }

  /**
   * Session-state rows (identity + latest details), excluding done rows. `activeSince`
   * can window quiet rows while keeping needs-you rows visible.
   */
  listSessionState(opts: { activeSince?: string } = {}): SessionStateRow[] {
    const where = opts.activeSince
      ? "WHERE d.state != 'done' AND (t.last_active_at >= ? OR d.state = 'needs-you')"
      : "WHERE d.state != 'done'";
    const stmt = this.db.prepare(
      `SELECT
         t.id,
         COALESCE(t.source, '') AS source,
         COALESCE(t.repo, '') AS repo,
         COALESCE(t.app, '') AS app,
         COALESCE(t.owner_title, d.topic, t.raw_topic, '') AS topic,
         COALESCE(d.topic, t.raw_topic, '') AS generatedTopic,
         t.owner_title AS ownerTitle,
         d.summary,
         d.next_steps AS nextSteps,
         d.priority,
         d.state,
         d.state_reason AS stateReason,
         t.last_active_at AS lastActiveAt,
         t.created_at AS createdAt,
         t.last_message_at AS lastMessageAt,
         t.diff_added AS diffAdded,
         t.diff_deleted AS diffDeleted
       FROM threads t
       JOIN thread_details d
         ON d.thread_id = t.id
        AND d.version = (SELECT MAX(version) FROM thread_details WHERE thread_id = t.id)
       ${where}
       ORDER BY
         CASE d.state WHEN 'needs-you' THEN 0 WHEN 'working' THEN 1 WHEN 'idle' THEN 2 ELSE 3 END,
         t.last_message_at DESC,
         t.repo COLLATE NOCASE ASC`,
    );
    const rows = (opts.activeSince ? stmt.all(opts.activeSince) : stmt.all()) as unknown as
      Array<Omit<SessionStateRow, "lastActive">>;
    // Relative freshness is DERIVED at read (a stored "2m ago" is stale by construction).
    const nowMs = Date.parse(this.now());
    return rows.map((r) => ({
      ...r,
      lastActive: r.lastMessageAt ? formatRelative((nowMs - Date.parse(r.lastMessageAt)) / 1000) : "",
    }));
  }

  // ---- the StatusSnapshot contract (what store.ts's seam serves) -------------------------

  /** True before any snapshot or thread has landed — gates the one-time legacy-JSON seed. */
  isEmpty(): boolean {
    if (this.db.prepare("SELECT value FROM meta WHERE key = 'polled_at'").get()) return false;
    const { n } = this.db.prepare("SELECT COUNT(*) AS n FROM threads").get() as { n: number };
    return n === 0;
  }

  /**
   * Persist a full poll snapshot as ONE IMMEDIATE transaction: rows in this snapshot get
   * `in_snapshot = 1`, everything else drops to 0 (rows are kept — history is
   * keep-forever). `first_seen_at` is insert-only, so identity continuity survives even
   * a caller that rebuilt from scratch. State goes through the guarded append: the
   * done-hold compares the incoming row against the STORED last_message_at (read before
   * this write updates it), so a writer holding a stale snapshot cannot resurrect an
   * owner-set `done` — the issue #3 bug class, cross-process edition. Steady-state polls
   * dedup to nothing in the ledger: only edges land.
   */
  saveSnapshot(snapshot: StatusSnapshot): void {
    const readStored = this.db.prepare("SELECT last_message_at AS lastMessageAt FROM threads WHERE id = ?");
    const upsert = this.db.prepare(
      `INSERT INTO threads (id, repo, project, app, source, raw_topic, owner_title, created_at,
         last_active_at, first_seen_at, last_seen_at, last_message_at, in_snapshot,
         last_checked_at, diff_added, diff_deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         repo = excluded.repo, app = excluded.app, source = excluded.source,
         project = COALESCE(excluded.project, threads.project),
         -- an owner rename is owner state: a poll snapshot (which never carries one) can't clear it
         owner_title = COALESCE(excluded.owner_title, threads.owner_title),
         raw_topic = excluded.raw_topic, created_at = excluded.created_at,
         last_active_at = excluded.last_active_at, last_seen_at = excluded.last_seen_at,
         diff_added = excluded.diff_added, diff_deleted = excluded.diff_deleted,
         last_message_at = excluded.last_message_at,
         in_snapshot = 1,
         last_checked_at = excluded.last_checked_at`,
    );
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec("UPDATE threads SET in_snapshot = 0 WHERE in_snapshot = 1");
      for (const t of snapshot.threads) {
        const stored = readStored.get(t.id) as { lastMessageAt: string | null } | undefined;
        upsert.run(
          t.id, t.repo, t.project ?? null, t.app, t.source, t.topic, t.ownerTitle ?? null, t.createdAt,
          t.lastMessageAt, // closest ISO activity signal the snapshot carries
          t.firstSeen, snapshot.polledAt, t.lastMessageAt, snapshot.polledAt,
          t.diffAdded ?? null, t.diffDeleted ?? null,
        );
        this.appendDetailsInTx(t.id, { state: t.state }, "poll", {
          observedLastMessageAt: t.lastMessageAt,
          holdIfNotNewerThan: stored?.lastMessageAt ?? null,
        });
      }
      this.db.prepare(
        "INSERT INTO meta (key, value) VALUES ('polled_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run(snapshot.polledAt);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * The current snapshot (poll-window rows + meta polled_at), or null before first poll.
   *
   * `in_snapshot = 1` is the latest poll window. We ALSO surface every `needs-you` thread,
   * window or not: a thread blocked on the owner must never drop off the session state just because
   * its last activity aged past the scan window — that silent disappearance is the exact
   * forgotten-commitment failure this product exists to prevent. (An out-of-window needs-you
   * carries its frozen last-known row; it leaves only when a newer message or `/done` moves it
   * off needs-you. Mirrors the `listSessionState` exemption — this is the live-path equivalent.)
   * Render sorts by attention, so these float to the top despite older timestamps.
   */
  loadSnapshot(): StatusSnapshot | null {
    const polled = this.db.prepare("SELECT value FROM meta WHERE key = 'polled_at'").get() as
      | { value: string } | undefined;
    if (!polled) return null;
    const rows = this.db.prepare(
      `SELECT t.id, t.source, t.repo, t.project, t.app, t.raw_topic AS topic,
              t.owner_title AS ownerTitle, d.state, t.created_at AS createdAt,
              t.last_message_at AS lastMessageAt, t.first_seen_at AS firstSeen,
              t.diff_added AS diffAdded, t.diff_deleted AS diffDeleted
       FROM threads t
       JOIN thread_details d
         ON d.thread_id = t.id
        AND d.version = (SELECT MAX(version) FROM thread_details WHERE thread_id = t.id)
       WHERE t.in_snapshot = 1 OR d.state = 'needs-you'
       ORDER BY t.last_message_at DESC`,
    ).all() as Array<Record<string, string | null> & { diffAdded: number | null; diffDeleted: number | null }>;
    const nowMs = Date.parse(this.now());
    return {
      polledAt: polled.value,
      threads: rows.map((r): ThreadStatus => ({
        id: String(r.id),
        source: r.source ?? "",
        repo: r.repo ?? "",
        ...(r.project ? { project: r.project } : {}),
        app: r.app ?? "",
        topic: r.topic ?? "",
        ...(r.ownerTitle ? { ownerTitle: r.ownerTitle } : {}),
        state: r.state as ThreadState,
        // Derived at read so it can't go stale in storage.
        lastActive: r.lastMessageAt ? formatRelative((nowMs - Date.parse(String(r.lastMessageAt))) / 1000) : "",
        createdAt: r.createdAt ?? "",
        lastMessageAt: r.lastMessageAt ?? "",
        firstSeen: r.firstSeen ?? "",
        ...(r.diffAdded != null ? { diffAdded: r.diffAdded } : {}),
        ...(r.diffDeleted != null ? { diffDeleted: r.diffDeleted } : {}),
      })),
    };
  }

  /**
   * Owner override: mark current-window threads done — one transaction, so it can never
   * interleave with a concurrent saveSnapshot. Idempotent on already-done rows (the
   * guarded append dedups them to no-ops).
   */
  markThreadsDone(ids: readonly string[]): {
    snapshot: StatusSnapshot | null; marked: ThreadStatus[]; missingIds: string[];
  } {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const polled = this.db.prepare("SELECT value FROM meta WHERE key = 'polled_at'").get();
      if (!polled) {
        this.db.exec("COMMIT");
        return { snapshot: null, marked: [], missingIds: [...ids] };
      }
      if (ids.length) {
        const inWindow = this.db.prepare(
          `SELECT id FROM threads WHERE in_snapshot = 1 AND id IN (${ids.map(() => "?").join(", ")})`,
        ).all(...ids) as Array<{ id: string }>;
        for (const { id } of inWindow) {
          this.appendDetailsInTx(id, { state: "done" }, "owner");
        }
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    const snapshot = this.loadSnapshot();
    const wanted = new Set(ids);
    const marked = (snapshot?.threads ?? []).filter((t) => wanted.has(t.id));
    const markedIds = new Set(marked.map((t) => t.id));
    return { snapshot, marked, missingIds: ids.filter((id) => !markedIds.has(id)) };
  }

  /**
   * Owner rename: pin a title on the thread. It wins over every generated topic at display;
   * model enrichment keeps writing topics into the versioned ledger (the audit trail) — they
   * just don't show while the pin is set. An empty/whitespace title clears the pin
   * (generated titles show again). Returns false for an unknown thread.
   */
  setOwnerTitle(threadId: string, title: string): boolean {
    const r = this.db.prepare("UPDATE threads SET owner_title = ? WHERE id = ?")
      .run(title.trim() || null, threadId);
    return Number(r.changes) > 0;
  }

  /**
   * Privacy purge: delete every thread (details/legacy-triage rows follow via CASCADE)
   * that belongs to a blacklisted tree or repo. Matches the stored cwd (`project`), the
   * repo name (case-insensitive), and the transcript path's Claude project-dir slug —
   * historical rows that predate the `project` column only carry the latter two.
   * Returns rows deleted.
   */
  purgeBlacklisted(bl: { paths: string[]; repos: string[] }): number {
    const conds: string[] = [];
    const params: string[] = [];
    for (const r of bl.repos) {
      conds.push("lower(repo) = lower(?)");
      params.push(r);
    }
    for (const p of bl.paths) {
      conds.push("(project = ? COLLATE NOCASE OR project LIKE ? || '/%' COLLATE NOCASE)");
      params.push(p, p);
      const slug = p.replace(/[^A-Za-z0-9-]/g, "-"); // keep in lockstep with core pathSlugs()
      conds.push("(transcript_path LIKE ? OR transcript_path LIKE ?)");
      params.push(`%/projects/${slug}/%`, `%/projects/${slug}-%`);
    }
    if (!conds.length) return 0;
    const r = this.db.prepare(`DELETE FROM threads WHERE ${conds.join(" OR ")}`).run(...params);
    return Number(r.changes);
  }

  // ---- schedules & triggers (the daemon's domain; see daemon.ts) -------------------------

  /** All schedules, by name. JSON columns keep the shapes free to evolve with protocol.ts. */
  listSchedules(): Schedule[] {
    const rows = this.db.prepare(
      "SELECT name, when_json, action_json, enabled, last_run_at, last_result_json FROM schedules ORDER BY name",
    ).all() as Array<{ name: string; when_json: string; action_json: string; enabled: number; last_run_at: string | null; last_result_json: string | null }>;
    return rows.map((r): Schedule => ({
      name: r.name,
      when: JSON.parse(r.when_json) as ScheduleWhen,
      action: JSON.parse(r.action_json) as ScheduleAction,
      enabled: !!r.enabled,
      ...(r.last_run_at ? { lastRunAt: r.last_run_at } : {}),
      ...(r.last_result_json ? { lastResult: JSON.parse(r.last_result_json) as Schedule["lastResult"] } : {}),
    }));
  }

  /** Upsert by name. Run bookkeeping (last_run/last_result) survives a definition update. */
  upsertSchedule(s: Pick<Schedule, "name" | "when" | "action" | "enabled">): Schedule {
    this.db.prepare(
      `INSERT INTO schedules (name, when_json, action_json, enabled, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         when_json = excluded.when_json, action_json = excluded.action_json, enabled = excluded.enabled`,
    ).run(s.name, JSON.stringify(s.when), JSON.stringify(s.action), s.enabled ? 1 : 0, this.now());
    return this.listSchedules().find((x) => x.name === s.name)!;
  }

  deleteSchedule(name: string): boolean {
    const r = this.db.prepare("DELETE FROM schedules WHERE name = ?").run(name);
    return Number(r.changes) > 0;
  }

  recordScheduleRun(name: string, result: { ok: boolean; detail?: string; at: string }): void {
    this.db.prepare("UPDATE schedules SET last_run_at = ?, last_result_json = ? WHERE name = ?")
      .run(result.at, JSON.stringify(result), name);
  }

  close(): void {
    this.db.close();
  }
}
