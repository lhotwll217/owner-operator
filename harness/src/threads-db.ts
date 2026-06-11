// Owner Operator — durable thread db. The SQLite engine behind store.ts's seam: where the
// JSON export keeps only the LATEST snapshot, this keeps history — thread identity across
// polls (first_seen), the state edge log, versioned triage, and the current poll window
// (in_snapshot). node:sqlite, dependency-free.
//
// MULTI-CONSUMER WRITING — why concurrent writer processes (TUI + one-shot oo + future
// widget/web) are safe here, and the rules any NEW writer must follow:
//   • WAL + busy_timeout(5s): readers never block the writer; a second writer queues
//     briefly instead of throwing SQLITE_BUSY on first collision.
//   • Every logical mutation is ONE `BEGIN IMMEDIATE` transaction. Never read-then-write
//     across two transactions — that reintroduces the last-writer-wins clobber.
//   • saveSnapshot() re-applies the canonical done-hold INSIDE the write (a SQL
//     transcription of holdsDone(), packages/core/src/resolve.mjs), so a writer holding a
//     stale snapshot cannot resurrect an operator-set `done`. A new "rebuild the world"
//     writer must go through saveSnapshot, never raw UPDATEs on `state`.
//   • Change events are in-process only. A cross-process consumer reads the derived
//     status.json (see store.ts) or queries the db read-only and watches the -wal file +
//     PRAGMA data_version. When the gateway daemon lands (openclaw pattern,
//     docs/inspiration.md), it becomes the only writer and pushes these edges itself.
//
// Tables:
//   threads       — identity + resolved state (current value) + poll-window membership
//   thread_triage — versioned model output (append-only; latest version wins)
//   meta          — store-level keys (polled_at = the current snapshot's timestamp)

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  STATE_RANK,
  type StatusSnapshot,
  type ThreadState,
  type ThreadStatus,
  type TriageInfo,
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

export type TriageSource = "startup" | "targeted_refresh" | "manual" | "model";

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
  last_checked_at   TEXT,
  -- snapshot-window columns (the StatusSnapshot contract; see saveSnapshot/loadSnapshot)
  last_message_at   TEXT,
  last_active_rel   TEXT,
  state_since       TEXT,
  previous_state    TEXT,
  in_snapshot       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_threads_in_snapshot ON threads(in_snapshot);

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
    this.migrate();
    this.now = opts.now ?? (() => new Date().toISOString());
  }

  // Dbs created before the snapshot columns existed get them ALTERed in (additive only;
  // a fresh CREATE above already carries them).
  private migrate(): void {
    const cols = new Set(
      (this.db.prepare("PRAGMA table_info(threads)").all() as Array<{ name: string }>).map((c) => c.name),
    );
    const add = (ddl: string): void => { this.db.exec(`ALTER TABLE threads ADD COLUMN ${ddl}`); };
    if (!cols.has("last_message_at")) add("last_message_at TEXT");
    if (!cols.has("last_active_rel")) add("last_active_rel TEXT");
    if (!cols.has("state_since")) add("state_since TEXT");
    if (!cols.has("previous_state")) add("previous_state TEXT");
    if (!cols.has("in_snapshot")) add("in_snapshot INTEGER NOT NULL DEFAULT 0");
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

  // ---- the StatusSnapshot contract (what store.ts's seam serves) -------------------------

  /** True before any snapshot or thread has landed — gates the one-time legacy-JSON seed. */
  isEmpty(): boolean {
    if (this.db.prepare("SELECT value FROM meta WHERE key = 'polled_at'").get()) return false;
    const { n } = this.db.prepare("SELECT COUNT(*) AS n FROM threads").get() as { n: number };
    return n === 0;
  }

  /**
   * Persist a full poll snapshot — the whole-window replace the JSON store used to do, as
   * ONE IMMEDIATE transaction: rows in this snapshot get `in_snapshot = 1`, everything
   * else drops to 0 (rows are kept — history is keep-forever). `first_seen_at` is
   * insert-only, so identity continuity survives even a caller that rebuilt from scratch.
   *
   * THE WRITE-BOUNDARY BACKSTOP: `state` goes through a SQL transcription of `holdsDone()`
   * (packages/core/src/resolve.mjs — keep the two in lockstep). Without it, a writer that
   * loaded its snapshot BEFORE another consumer marked a thread done would clobber that
   * done back to active — the issue #3 bug class, cross-process edition. With it,
   * saveSnapshot is safe to call with a stale snapshot: done holds unless the incoming
   * row carries a NEWER message.
   */
  saveSnapshot(snapshot: StatusSnapshot): void {
    const upsert = this.db.prepare(
      `INSERT INTO threads (id, repo, app, source, raw_topic, created_at, last_active_at,
         first_seen_at, last_seen_at, state, last_message_at, last_active_rel,
         state_since, previous_state, in_snapshot, last_checked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT(id) DO UPDATE SET
         repo = excluded.repo, app = excluded.app, source = excluded.source,
         raw_topic = excluded.raw_topic, created_at = excluded.created_at,
         last_active_at = excluded.last_active_at, last_seen_at = excluded.last_seen_at,
         state = CASE WHEN threads.state = 'done' AND excluded.last_message_at <= threads.last_message_at
                      THEN 'done' ELSE excluded.state END,
         state_since = CASE WHEN threads.state = 'done' AND excluded.last_message_at <= threads.last_message_at
                      THEN threads.state_since ELSE excluded.state_since END,
         previous_state = CASE WHEN threads.state = 'done' AND excluded.last_message_at <= threads.last_message_at
                      THEN threads.previous_state ELSE excluded.previous_state END,
         last_message_at = excluded.last_message_at,
         last_active_rel = excluded.last_active_rel,
         in_snapshot = 1,
         last_checked_at = excluded.last_checked_at`,
    );
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec("UPDATE threads SET in_snapshot = 0 WHERE in_snapshot = 1");
      for (const t of snapshot.threads) {
        upsert.run(
          t.id, t.repo, t.app, t.source, t.topic, t.createdAt,
          t.lastMessageAt, // closest ISO activity signal the snapshot carries
          t.firstSeen, snapshot.polledAt, t.state, t.lastMessageAt, t.lastActive,
          t.stateSince, t.previousState ?? null, snapshot.polledAt,
        );
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

  /** The current snapshot (poll-window rows + meta polled_at), or null before first poll. */
  loadSnapshot(): StatusSnapshot | null {
    const polled = this.db.prepare("SELECT value FROM meta WHERE key = 'polled_at'").get() as
      | { value: string } | undefined;
    if (!polled) return null;
    const rows = this.db.prepare(
      `SELECT id, source, repo, app, raw_topic AS topic, state,
              last_active_rel AS lastActive, created_at AS createdAt,
              last_message_at AS lastMessageAt, first_seen_at AS firstSeen,
              state_since AS stateSince, previous_state AS previousState
       FROM threads WHERE in_snapshot = 1
       ORDER BY last_message_at DESC`,
    ).all() as Array<Record<string, string | null>>;
    return {
      polledAt: polled.value,
      threads: rows.map((r): ThreadStatus => ({
        id: String(r.id),
        source: r.source ?? "",
        repo: r.repo ?? "",
        app: r.app ?? "",
        topic: r.topic ?? "",
        state: r.state as ThreadState,
        lastActive: r.lastActive ?? "",
        createdAt: r.createdAt ?? "",
        lastMessageAt: r.lastMessageAt ?? "",
        firstSeen: r.firstSeen ?? "",
        stateSince: r.stateSince ?? "",
        ...(r.previousState ? { previousState: r.previousState as ThreadState } : {}),
      })),
    };
  }

  /**
   * Operator override: mark current-window threads done — one transaction, so it can never
   * interleave with a concurrent saveSnapshot. Idempotent on already-done rows
   * (stateSince/previousState keep their first-mark values).
   */
  markThreadsDone(ids: readonly string[], now: string): {
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
        this.db.prepare(
          `UPDATE threads SET
             previous_state = CASE WHEN state = 'done' THEN previous_state ELSE state END,
             state_since    = CASE WHEN state = 'done' THEN state_since ELSE ? END,
             state = 'done'
           WHERE in_snapshot = 1 AND id IN (${ids.map(() => "?").join(", ")})`,
        ).run(now, ...ids);
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
   * Idempotent triage upsert for the cache seam (the tui re-saves its WHOLE map): appends
   * a new version ONLY when the latest differs, so unchanged entries stay version-stable.
   * Unknown thread ids get a stub row (in_snapshot = 0 → invisible to snapshots until a
   * poll sees them) so the FK holds and a pre-poll triage isn't lost.
   */
  upsertTriage(threadId: string, t: TriageInfo, source: TriageSource): number | null {
    const now = this.now();
    let version: number | null = null;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(
        "INSERT OR IGNORE INTO threads (id, first_seen_at, last_seen_at, state, in_snapshot) VALUES (?, ?, ?, 'idle', 0)",
      ).run(threadId, now, now);
      const latest = this.db.prepare(
        `SELECT version, priority, topic, summary, next_steps AS nextSteps
         FROM thread_triage WHERE thread_id = ? ORDER BY version DESC LIMIT 1`,
      ).get(threadId) as
        | { version: number; priority: number | null; topic: string | null; summary: string | null; nextSteps: string | null }
        | undefined;
      const same = latest
        && latest.priority === (t.priority ?? null) && latest.topic === (t.topic ?? null)
        && latest.summary === (t.summary ?? null) && latest.nextSteps === (t.nextSteps ?? null);
      if (!same) {
        version = (latest?.version ?? 0) + 1;
        this.db.prepare(
          `INSERT INTO thread_triage (thread_id, version, priority, topic, summary, next_steps, source, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(threadId, version, t.priority ?? null, t.topic ?? null, t.summary ?? null, t.nextSteps ?? null, source, now);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    if (version != null) this.emit({ type: "triage_updated", threadId, version });
    return version;
  }

  /** Latest triage per thread, as the cache map the rail joins by id. */
  getTriageMap(): Map<string, TriageInfo> {
    const rows = this.db.prepare(
      `SELECT thread_id AS threadId, priority, topic, summary, next_steps AS nextSteps
       FROM thread_triage x
       WHERE version = (SELECT MAX(version) FROM thread_triage WHERE thread_id = x.thread_id)`,
    ).all() as Array<{ threadId: string; priority: number | null; topic: string | null; summary: string | null; nextSteps: string | null }>;
    const map = new Map<string, TriageInfo>();
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

  close(): void {
    this.db.close();
  }
}
