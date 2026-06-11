// Owner Operator — durable thread db. The SQLite layer store.ts's seam anticipates
// ("swapping in sqlite later is a one-file change"): where the JSON store keeps only the
// LATEST snapshot, this keeps history — thread identity across polls (first_seen), the
// state edge log, and versioned triage. node:sqlite, dependency-free. Not yet wired into
// the poller/TUI; the JSON seam stays the hot path until this replaces it.
//
// Single-writer by design: the writer doubles as the event bus — writes detect state
// edges and emit to in-process subscribers. Cold readers just query the file; a reader
// without the harness watches the -wal file + PRAGMA data_version.
//
// Two tables:
//   threads       — identity + observed state (scan-derived, current value only)
//   thread_triage — versioned model output (append-only; latest version wins)

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { STATE_RANK, type ThreadState } from "@owner-operator/core";
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

export type TriageSource = "startup" | "targeted_refresh" | "manual";

export interface TriageInput {
  priority?: number;
  topic?: string;
  summary?: string;
  nextSteps?: string;
  source: TriageSource;
  model?: string;
  promptVersion?: string;
  inputHash?: string;
}

export interface TriageRow {
  threadId: string;
  version: number;
  priority: number | null;
  topic: string | null;
  summary: string | null;
  nextSteps: string | null;
  source: TriageSource;
  model: string | null;
  promptVersion: string | null;
  inputHash: string | null;
  createdAt: string;
}

/** The sidebar projection: identity + state + latest triage, one row per thread. */
export interface SidebarRow {
  id: string;
  repo: string | null;
  app: string | null;
  topic: string | null;
  nextSteps: string | null;
  priority: number | null;
  state: ThreadState;
  stateReason: string | null;
  lastActiveAt: string | null;
}

/** Change events, emitted post-commit. Edges, not snapshots — same idea as StatusDiff. */
export type ThreadDbEvent =
  | { type: "thread_added"; threadId: string; state: ThreadState }
  | { type: "state_changed"; threadId: string; from: ThreadState; to: ThreadState; reason: string | null }
  | { type: "triage_updated"; threadId: string; version: number };

export interface RecordScanResult {
  added: boolean;
  stateChanged: { from: ThreadState; to: ThreadState } | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS threads (
  id              TEXT PRIMARY KEY,
  repo            TEXT,
  app             TEXT,
  source          TEXT,
  transcript_path TEXT,
  created_at      TEXT,
  last_active_at  TEXT,
  first_seen_at   TEXT NOT NULL,
  last_seen_at    TEXT NOT NULL,
  raw_topic       TEXT,
  state             TEXT NOT NULL DEFAULT 'idle'
                    CHECK (state IN ('needs-you', 'working', 'idle', 'done')),
  state_reason      TEXT,
  last_assistant_at TEXT,
  last_user_at      TEXT,
  last_checked_at   TEXT
);

CREATE TABLE IF NOT EXISTS thread_triage (
  thread_id      TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  version        INTEGER NOT NULL,
  priority       INTEGER,
  topic          TEXT,
  summary        TEXT,
  next_steps     TEXT,
  source         TEXT NOT NULL,
  model          TEXT,
  prompt_version TEXT,
  input_hash     TEXT,
  created_at     TEXT NOT NULL,
  PRIMARY KEY (thread_id, version)
);

CREATE INDEX IF NOT EXISTS idx_thread_triage_latest
ON thread_triage(thread_id, version DESC);
`;

export class ThreadDb {
  private db: DatabaseSync;
  private now: () => string;
  private listeners = new Set<(e: ThreadDbEvent) => void>();

  constructor(dbPath: string = defaultDbPath(), opts: { now?: () => string } = {}) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    // A TUI and a one-shot oo can hold the db at once; wait briefly instead of
    // throwing SQLITE_BUSY on the first collision.
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec(SCHEMA);
    this.now = opts.now ?? (() => new Date().toISOString());
  }

  /** Listen for change events (edges, not snapshots). Returns an unsubscribe fn. */
  subscribe(listener: (e: ThreadDbEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(e: ThreadDbEvent): void {
    for (const l of this.listeners) {
      try { l(e); } catch { /* a broken subscriber must not break the write path */ }
    }
  }

  /** Upsert one poll observation. Detects the state edge and emits events post-commit. */
  recordScan(obs: ThreadObservation): RecordScanResult {
    if (!isThreadState(obs.state)) throw new Error(`invalid thread state: ${obs.state}`);
    const now = this.now();
    const events: ThreadDbEvent[] = [];
    let result: RecordScanResult;

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const prev = this.db
        .prepare("SELECT state, state_reason FROM threads WHERE id = ?")
        .get(obs.id) as { state: string; state_reason: string | null } | undefined;

      if (!prev) {
        this.db.prepare(
          `INSERT INTO threads (id, repo, app, source, transcript_path, created_at,
             last_active_at, first_seen_at, last_seen_at, raw_topic,
             state, state_reason, last_assistant_at, last_user_at, last_checked_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          obs.id, obs.repo ?? null, obs.app ?? null, obs.source ?? null,
          obs.transcriptPath ?? null, obs.createdAt ?? null, obs.lastActiveAt ?? null,
          now, now, obs.rawTopic ?? null,
          obs.state, obs.stateReason ?? null,
          obs.lastAssistantAt ?? null, obs.lastUserAt ?? null, now,
        );
        events.push({ type: "thread_added", threadId: obs.id, state: obs.state });
        result = { added: true, stateChanged: null };
      } else {
        // COALESCE keeps stored identity when the observation omits a field.
        // state_reason: a state CHANGE always overwrites it (a stale reason on a new
        // state is worse than none); a steady-state poll keeps the stored reason unless
        // it brings a fresh one.
        const from = prev.state as ThreadState;
        const reason = from !== obs.state
          ? obs.stateReason ?? null
          : obs.stateReason ?? prev.state_reason;
        this.db.prepare(
          `UPDATE threads SET
             repo = COALESCE(?, repo), app = COALESCE(?, app), source = COALESCE(?, source),
             transcript_path = COALESCE(?, transcript_path),
             created_at = COALESCE(?, created_at),
             last_active_at = COALESCE(?, last_active_at),
             raw_topic = COALESCE(?, raw_topic),
             last_seen_at = ?,
             state = ?, state_reason = ?,
             last_assistant_at = COALESCE(?, last_assistant_at),
             last_user_at = COALESCE(?, last_user_at),
             last_checked_at = ?
           WHERE id = ?`,
        ).run(
          obs.repo ?? null, obs.app ?? null, obs.source ?? null,
          obs.transcriptPath ?? null, obs.createdAt ?? null, obs.lastActiveAt ?? null,
          obs.rawTopic ?? null,
          now,
          obs.state, reason,
          obs.lastAssistantAt ?? null, obs.lastUserAt ?? null,
          now, obs.id,
        );
        if (from !== obs.state) {
          events.push({
            type: "state_changed", threadId: obs.id,
            from, to: obs.state, reason: obs.stateReason ?? null,
          });
          result = { added: false, stateChanged: { from, to: obs.state } };
        } else {
          result = { added: false, stateChanged: null };
        }
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }

    for (const e of events) this.emit(e);
    return result;
  }

  /** Append a triage snapshot for a thread. Versions are per-thread, monotonic from 1. */
  addTriage(threadId: string, t: TriageInput): number {
    const now = this.now();
    let version: number;

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare("SELECT COALESCE(MAX(version), 0) + 1 AS v FROM thread_triage WHERE thread_id = ?")
        .get(threadId) as { v: number };
      version = row.v;
      this.db.prepare(
        `INSERT INTO thread_triage (thread_id, version, priority, topic, summary,
           next_steps, source, model, prompt_version, input_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        threadId, version, t.priority ?? null, t.topic ?? null, t.summary ?? null,
        t.nextSteps ?? null, t.source, t.model ?? null, t.promptVersion ?? null,
        t.inputHash ?? null, now,
      );
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }

    this.emit({ type: "triage_updated", threadId, version });
    return version;
  }

  getLatestTriage(threadId: string): TriageRow | undefined {
    return this.db.prepare(
      `SELECT thread_id AS threadId, version, priority, topic, summary,
              next_steps AS nextSteps, source, model, prompt_version AS promptVersion,
              input_hash AS inputHash, created_at AS createdAt
       FROM thread_triage WHERE thread_id = ?
       ORDER BY version DESC LIMIT 1`,
    ).get(threadId) as TriageRow | undefined;
  }

  /**
   * Identity + state + latest triage, most-recently-active first.
   *
   * `activeSince` (ISO timestamp) windows out stale threads — but only quiet ones:
   * needs-you is exempt, because a blocked thread aging out of view is exactly the
   * forgotten-commitment failure this product exists to prevent. Omit to get everything
   * (retention is keep-forever; this is a display filter, not deletion).
   */
  listSidebar(opts: { activeSince?: string } = {}): SidebarRow[] {
    const where = opts.activeSince
      ? "WHERE t.last_active_at >= ? OR t.state = 'needs-you'"
      : "";
    const stmt = this.db.prepare(
      `SELECT
         t.id, t.repo, t.app,
         COALESCE(latest.topic, t.raw_topic) AS topic,
         latest.next_steps AS nextSteps,
         latest.priority,
         t.state,
         t.state_reason AS stateReason,
         t.last_active_at AS lastActiveAt
       FROM threads t
       LEFT JOIN thread_triage latest
         ON latest.thread_id = t.id
        AND latest.version = (SELECT MAX(version) FROM thread_triage WHERE thread_id = t.id)
       ${where}
       ORDER BY t.last_active_at DESC`,
    );
    const rows = opts.activeSince ? stmt.all(opts.activeSince) : stmt.all();
    return rows as unknown as SidebarRow[];
  }

  close(): void {
    this.db.close();
  }
}
