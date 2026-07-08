// Owner Operator — read-only SQL access to the threads db, the progressive-disclosure
// surface behind the agent's query_database tool: list tables → describe one → run a
// SELECT. Sanctioned by threads-db.ts's multi-consumer rules: consumers without the
// daemon query the db read-only; WAL keeps readers from ever blocking the writer.
//
// Enforcement is the connection itself ({ readOnly: true } — any write statement throws
// SQLITE_READONLY), not statement inspection. Each call opens fresh and closes: no held
// handles, and a db created mid-process is picked up.

import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { defaultDbPath } from "./threads-db";
import { tableDoc } from "./schema-docs";

export interface TableInfo {
  name: string;
  rows: number;
  /** From schema-docs.ts (a git-tracked prompt surface), never the db file. */
  description: string;
}

export interface ColumnInfo {
  name: string;
  type: string;
  notNull: boolean;
  primaryKey: boolean;
  /** From schema-docs.ts; "(undocumented)" flags drift between code and db. */
  description: string;
}

export interface QueryResult {
  rows: Record<string, unknown>[];
  /** True when the LIMIT cap cut the result — the caller should narrow the query. */
  truncated: boolean;
}

/** Max rows a single query returns; keeps one tool result from flooding a context. */
export const QUERY_ROW_CAP = 200;

function openReadOnly(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

function withDb<T>(dbPath: string, fn: (db: DatabaseSync) => T): T {
  if (!existsSync(dbPath)) {
    throw new Error(`no threads db at ${dbPath} — the poller has not run yet`);
  }
  const db = openReadOnly(dbPath);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

// Table/column EXISTENCE and row counts come live from the db; DESCRIPTIONS come from
// schema-docs.ts. Deliberately decoupled: sqlite_master's stored CREATE text is frozen
// at whatever ran first on this machine's db file, while the code doc is git-tracked
// and versioned with the writers — it's a prompt surface, not db state.

export function listTables(dbPath: string = defaultDbPath()): TableInfo[] {
  return withDb(dbPath, (db) => {
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string }>;
    return names.map(({ name }) => {
      const { n } = db.prepare(`SELECT COUNT(*) AS n FROM "${name.replaceAll('"', '""')}"`).get() as { n: number };
      return { name, rows: n, description: tableDoc(name)?.description ?? "(undocumented)" };
    });
  });
}

export function describeTable(table: string, dbPath: string = defaultDbPath()): { description: string; columns: ColumnInfo[] } {
  return withDb(dbPath, (db) => {
    const exists = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table);
    if (!exists) throw new Error(`no such table: ${table}`);
    const doc = tableDoc(table);
    const colDocs = new Map((doc?.columns ?? []).map((c) => [c.name, c.description]));
    const cols = db.prepare(`PRAGMA table_info("${table.replaceAll('"', '""')}")`).all() as Array<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }>;
    return {
      description: doc?.description ?? "(undocumented)",
      columns: cols.map((c) => ({
        name: c.name,
        type: c.type,
        notNull: c.notnull !== 0,
        primaryKey: c.pk !== 0,
        description: colDocs.get(c.name) ?? "(undocumented)",
      })),
    };
  });
}

export function runQuery(sql: string, dbPath: string = defaultDbPath()): QueryResult {
  // The read-only connection blocks writes; this closes the one read that bypasses it.
  // ATTACH would let a caller read arbitrary SQLite files outside this db — a second
  // file-read surface that sidesteps the read tool's privacy blacklist. A SELECT never
  // needs it. Comments stripped first so `/* */ ATTACH` can't slip through.
  const bare = sql.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
  if (/(^|;)\s*(attach|detach)\b/i.test(bare)) {
    throw new Error("ATTACH/DETACH is not allowed; query only the session database");
  }
  return withDb(dbPath, (db) => {
    const rows = db.prepare(sql).all() as Record<string, unknown>[];
    return rows.length > QUERY_ROW_CAP
      ? { rows: rows.slice(0, QUERY_ROW_CAP), truncated: true }
      : { rows, truncated: false };
  });
}
