// Deterministic test of the read-only query surface: progressive disclosure over a real
// ThreadDb (list → describe → query), the row cap, and — the guarantee that matters —
// write statements failing on the read-only connection.
//   npm run test:unit

import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "oo-query-db-"));
const dbPath = join(dir, "state.db");

try {
  const { ThreadDb } = await import("./database");
  const { listTables, describeTable, runQuery, QUERY_ROW_CAP } = await import("./query");

  // Missing db → a friendly error, not an sqlite one.
  assert.throws(() => listTables(join(dir, "absent.db")), /daemon has not initialized/);

  // Seed through the real writer so the schema is the production one.
  const db = new ThreadDb(dbPath, { now: () => "2026-07-07T10:00:00.000Z" });
  db.recordScan({ id: "t1", repo: "demo", app: "Claude CLI", source: "claude", state: "needs-you", rawTopic: "ship it" });
  db.recordScan({ id: "t2", repo: "demo", app: "Codex CLI", source: "codex", state: "working" });
  db.appendModelDetails("t1", { priority: 4, topic: "Ship the fix" });
  db.appendModelDetails("t1", { priority: 2, topic: "Shipped; verify CI" });
  db.close();

  const tables = listTables(dbPath);
  const byName = new Map(tables.map((t) => [t.name, t]));
  assert.equal(byName.get("threads")?.rows, 2, "threads row count");
  assert.equal(byName.get("thread_details")?.rows, 4, "ledger rows: one state edge + two model appends + t2's edge");
  assert.match(byName.get("thread_details")?.description ?? "", /append-only/i, "table description served from schema-docs, not the db file");

  const desc = describeTable("thread_details", dbPath);
  assert.match(desc.description, /audit trail/i, "table description is the in-code doc");
  const version = desc.columns.find((c) => c.name === "version");
  assert.ok(version?.primaryKey, "composite pk visible in columns");
  assert.match(version?.description ?? "", /monotonic/, "column description served from schema-docs");
  assert.throws(() => describeTable("nope", dbPath), /no such table: nope/);

  // The audit-trail query the tool exists for: one thread's story, in version order.
  const audit = runQuery(
    "SELECT version, priority, topic FROM thread_details WHERE thread_id = 't1' AND written_by = 'model' ORDER BY version",
    dbPath,
  );
  assert.deepEqual(
    audit.rows.map((r) => [r.version, r.priority, r.topic]),
    [[2, 4, "Ship the fix"], [3, 2, "Shipped; verify CI"]],
    "enrichment history readable in version order, attributable via written_by",
  );
  assert.equal(audit.truncated, false);

  // Row cap: a generated series larger than the cap comes back truncated.
  const big = runQuery(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n LIMIT ${QUERY_ROW_CAP + 5}) SELECT i FROM n`,
    dbPath,
  );
  assert.equal(big.rows.length, QUERY_ROW_CAP);
  assert.equal(big.truncated, true);

  // Read-only enforcement lives in the connection, not statement parsing.
  assert.throws(() => runQuery("DELETE FROM threads", dbPath), /read.?only|READONLY/i);
  assert.throws(() => runQuery("INSERT INTO thread_details (thread_id, version, created_at, written_by, state) VALUES ('t1', 99, 'x', 'model', 'idle')", dbPath), /read.?only|READONLY/i);

  // ATTACH is the one read the read-only connection would otherwise allow — a cross-file
  // read surface past the privacy blacklist. Rejected, including comment-obfuscated forms.
  assert.throws(() => runQuery("ATTACH '/tmp/x.db' AS e; SELECT * FROM e.s", dbPath), /ATTACH/);
  assert.throws(() => runQuery("SELECT 1;\n  attach database '/tmp/x.db' as e", dbPath), /ATTACH/);
  assert.throws(() => runQuery("/* sneaky */ ATTACH '/tmp/x.db' AS e", dbPath), /ATTACH/);
  // A legit SELECT that merely mentions "attach" in a filter is NOT rejected.
  assert.equal(runQuery("SELECT topic FROM thread_details WHERE topic LIKE '%attach%'", dbPath).rows.length, 0);

  console.log("query-db: ok");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
