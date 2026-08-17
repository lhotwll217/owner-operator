// Integration: open a pre-effort agent_runs database and prove the additive migration preserves
// unknown legacy intent as NULL rather than inventing an effort value.
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AgentRunHarness } from "@owner-operator/core";
import { ThreadDb } from "./database";

const legacyDir = mkdtempSync(join(tmpdir(), "oo-agent-run-effort-migration-"));
try {
  const legacyPath = join(legacyDir, "state.db");
  const legacy = new DatabaseSync(legacyPath);
  legacy.exec(`
    CREATE TABLE agent_runs (
      id TEXT PRIMARY KEY,
      harness TEXT NOT NULL,
      task TEXT NOT NULL,
      cwd TEXT NOT NULL,
      parent_thread_id TEXT,
      model TEXT,
      depth INTEGER NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      activity TEXT,
      last_activity_at TEXT,
      child_session_id TEXT,
      acpx_record_id TEXT,
      result_tail TEXT,
      error TEXT,
      resume_of_run_id TEXT,
      timeout_seconds INTEGER NOT NULL
    );
    INSERT INTO agent_runs (
      id, harness, task, cwd, depth, status, created_at, timeout_seconds
    ) VALUES (
      'legacy-run', 'codex', 'legacy task', '/tmp/repo', 1, 'completed',
      '2026-07-01T00:00:00.000Z', 3600
    );
  `);
  legacy.close();

  const migrated = new ThreadDb(legacyPath);
  const legacyRun = migrated.agentRunById("legacy-run");
  assert.equal(legacyRun?.effort, null, "migration never backfills an invented effort");
  assert.equal(legacyRun?.effortApplied, false, "legacy null effort is distinguishably unapplied");
  migrated.close();
} finally {
  rmSync(legacyDir, { recursive: true, force: true });
}

process.stdout.write("ok — legacy agent_runs migrate with null effort\n");

const constrainedDir = mkdtempSync(join(tmpdir(), "oo-agent-run-effort-constraint-migration-"));
try {
  const dbPath = join(constrainedDir, "state.db");
  const prior = new DatabaseSync(dbPath);
  prior.exec(`
    CREATE TABLE agent_runs (
      id TEXT PRIMARY KEY, harness TEXT NOT NULL, task TEXT NOT NULL, cwd TEXT NOT NULL,
      parent_thread_id TEXT, model TEXT,
      effort TEXT CHECK (effort IS NULL OR effort IN ('minimal','low','medium','high','xhigh')),
      effort_applied INTEGER NOT NULL DEFAULT 0 CHECK (effort_applied IN (0,1)),
      harness_model TEXT,
      harness_effort TEXT CHECK (harness_effort IS NULL OR harness_effort IN ('minimal','low','medium','high','xhigh','max','ultra')),
      harness_identity_observed INTEGER NOT NULL DEFAULT 0 CHECK (harness_identity_observed IN (0,1)),
      depth INTEGER NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, started_at TEXT,
      finished_at TEXT, activity TEXT, last_activity_at TEXT, child_session_id TEXT,
      acpx_record_id TEXT, result_tail TEXT, error TEXT,
      resume_of_run_id TEXT REFERENCES agent_runs(id), timeout_seconds INTEGER NOT NULL
    );
    CREATE INDEX idx_agent_runs_status_created ON agent_runs(status, created_at);
    CREATE INDEX idx_agent_runs_child_session ON agent_runs(child_session_id) WHERE child_session_id IS NOT NULL;
    CREATE INDEX idx_agent_runs_parent_created ON agent_runs(parent_thread_id, created_at DESC) WHERE parent_thread_id IS NOT NULL;
    INSERT INTO agent_runs (id,harness,task,cwd,effort,depth,status,created_at,timeout_seconds)
      VALUES ('prior-row','codex','kept','/tmp/repo','xhigh',1,'completed','2026-07-01T00:00:00.000Z',3600);
  `);
  prior.close();
  const upgraded = new ThreadDb(dbPath);
  assert.equal(upgraded.agentRunById("prior-row")?.task, "kept", "constraint upgrade preserves existing rows");
  assert.equal(upgraded.createAgentRun({ id: "max-row", harness: AgentRunHarness.Codex, task: "max", cwd: "/tmp/repo", effort: "max", depth: 1, timeoutSeconds: 60 }).effort, "max");
  assert.equal(upgraded.createAgentRun({ id: "ultra-row", harness: AgentRunHarness.Codex, task: "ultra", cwd: "/tmp/repo", effort: "ultra", depth: 1, timeoutSeconds: 60 }).effort, "ultra");
  upgraded.claimNextPendingAgentRun(3);
  const maxObserved = upgraded.recordAgentRunActivity("max-row", { harnessIdentity: { observed: true, effort: "max" } });
  assert.deepEqual(maxObserved?.harnessIdentity, { observed: true, effort: "max" }, "new harness effort remains writable and readable after mixed-schema rebuild");
  upgraded.close();
  const inspect = new DatabaseSync(dbPath);
  const indexNames = (inspect.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_agent_runs_%' ORDER BY name").all() as Array<{ name: string }>).map(({ name }) => name);
  assert.deepEqual(indexNames, ["idx_agent_runs_child_session", "idx_agent_runs_parent_created", "idx_agent_runs_status_created"], "constraint upgrade preserves every agent-run index");
  inspect.close();
} finally {
  rmSync(constrainedDir, { recursive: true, force: true });
}

process.stdout.write("ok — prior effort constraints upgrade for max and ultra without data/index loss\n");

const relationshipDir = mkdtempSync(join(tmpdir(), "oo-agent-run-relationship-migration-"));
try {
  const dbPath = join(relationshipDir, "state.db");
  const prior = new DatabaseSync(dbPath);
  prior.exec(`
    CREATE TABLE agent_runs (
      id TEXT PRIMARY KEY, harness TEXT NOT NULL, task TEXT NOT NULL, cwd TEXT NOT NULL,
      parent_thread_id TEXT, model TEXT,
      effort TEXT CHECK (effort IS NULL OR effort IN ('minimal','low','medium','high','xhigh','max','ultra')),
      effort_applied INTEGER NOT NULL DEFAULT 0 CHECK (effort_applied IN (0,1)),
      harness_model TEXT,
      harness_effort TEXT CHECK (harness_effort IS NULL OR harness_effort IN ('minimal','low','medium','high','xhigh','max','ultra')),
      harness_identity_observed INTEGER NOT NULL DEFAULT 0 CHECK (harness_identity_observed IN (0,1)),
      depth INTEGER NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, started_at TEXT,
      finished_at TEXT, activity TEXT, last_activity_at TEXT, child_session_id TEXT,
      acpx_record_id TEXT, result_tail TEXT, error TEXT,
      resume_of_run_id TEXT REFERENCES agent_runs(id), timeout_seconds INTEGER NOT NULL
    );
    CREATE INDEX idx_agent_runs_status_created ON agent_runs(status, created_at);
    CREATE INDEX idx_agent_runs_child_session ON agent_runs(child_session_id) WHERE child_session_id IS NOT NULL;
    CREATE INDEX idx_agent_runs_parent_created ON agent_runs(parent_thread_id, created_at DESC) WHERE parent_thread_id IS NOT NULL;
    INSERT INTO agent_runs (id,harness,task,cwd,depth,status,created_at,child_session_id,acpx_record_id,resume_of_run_id,timeout_seconds) VALUES
      ('failed-run','codex','failed','/tmp/repo',1,'failed','2026-07-01T00:00:00.000Z','child-failed','acpx-failed',NULL,3600),
      ('old-main-retry','codex','failed','/tmp/repo',1,'completed','2026-07-01T00:01:00.000Z','child-failed','acpx-failed','failed-run',3600),
      ('interrupted-run','codex','interrupted','/tmp/repo',1,'interrupted','2026-07-01T00:01:10.000Z','child-interrupted','acpx-interrupted',NULL,3600),
      ('interrupted-retry','codex','interrupted','/tmp/repo',1,'completed','2026-07-01T00:01:20.000Z','child-interrupted','acpx-interrupted','interrupted-run',3600),
      ('lost-run','codex','lost','/tmp/repo',1,'lost','2026-07-01T00:01:30.000Z','child-lost','acpx-lost',NULL,3600),
      ('lost-retry','codex','lost','/tmp/repo',1,'completed','2026-07-01T00:01:40.000Z','child-lost','acpx-lost','lost-run',3600),
      ('completed-run','codex','completed','/tmp/repo',1,'completed','2026-07-01T00:02:00.000Z','child-completed','acpx-completed',NULL,3600),
      ('completed-resume','codex','follow up','/tmp/repo',1,'completed','2026-07-01T00:03:00.000Z','child-completed','acpx-completed','completed-run',3600),
      ('completed-self','codex','self','/tmp/repo',1,'completed','2026-07-01T00:04:00.000Z','child-self','acpx-self','completed-self',3600);
  `);
  prior.close();

  const upgraded = new ThreadDb(dbPath);
  assert.equal(upgraded.agentRunById("old-main-retry")?.retryOfRunId, "failed-run");
  assert.equal(upgraded.agentRunById("old-main-retry")?.resumeOfRunId, null);
  assert.equal(upgraded.agentRunById("interrupted-retry")?.retryOfRunId, "interrupted-run");
  assert.equal(upgraded.agentRunById("lost-retry")?.retryOfRunId, "lost-run");
  assert.equal(upgraded.agentRunById("completed-resume")?.retryOfRunId, null);
  assert.equal(upgraded.agentRunById("completed-resume")?.resumeOfRunId, "completed-run");
  assert.equal(upgraded.agentRunById("completed-self")?.resumeOfRunId, "completed-self");
  assert.equal(upgraded.listAgentRuns().length, 9, "relationship migration preserves every row");
  upgraded.close();

  const inspect = new DatabaseSync(dbPath);
  const columns = (inspect.prepare("PRAGMA table_info(agent_runs)").all() as Array<{ name: string }>)
    .map(({ name }) => name);
  assert.ok(columns.includes("retry_of_run_id"));
  assert.ok(columns.includes("resume_of_run_id"));
  assert.deepEqual(inspect.prepare("PRAGMA foreign_key_check(agent_runs)").all(), []);
  const indexNames = (inspect.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_agent_runs_%' ORDER BY name",
  ).all() as Array<{ name: string }>).map(({ name }) => name);
  assert.deepEqual(indexNames, [
    "idx_agent_runs_child_session",
    "idx_agent_runs_parent_created",
    "idx_agent_runs_status_created",
  ]);
  assert.throws(() => inspect.prepare(`
    INSERT INTO agent_runs (
      id,harness,task,cwd,depth,status,created_at,retry_of_run_id,resume_of_run_id,timeout_seconds
    ) VALUES ('invalid-both','codex','invalid','/tmp/repo',1,'pending','2026-07-01T00:05:00.000Z',
      'failed-run','completed-run',3600)
  `).run(), /CHECK constraint failed/);
  inspect.close();
} finally {
  rmSync(relationshipDir, { recursive: true, force: true });
}

process.stdout.write("ok — overloaded relationships migrate losslessly to retry/resume semantics\n");

const failedRebuildDir = mkdtempSync(join(tmpdir(), "oo-agent-run-failed-rebuild-"));
try {
  const dbPath = join(failedRebuildDir, "state.db");
  const prior = new DatabaseSync(dbPath);
  prior.exec(`
    PRAGMA foreign_keys = OFF;
    CREATE TABLE agent_runs (
      id TEXT PRIMARY KEY, harness TEXT NOT NULL, task TEXT NOT NULL, cwd TEXT NOT NULL,
      parent_thread_id TEXT, model TEXT,
      effort TEXT CHECK (effort IS NULL OR effort IN ('minimal','low','medium','high','xhigh')),
      effort_applied INTEGER NOT NULL DEFAULT 0 CHECK (effort_applied IN (0,1)),
      harness_model TEXT,
      harness_effort TEXT CHECK (harness_effort IS NULL OR harness_effort IN ('minimal','low','medium','high','xhigh','max','ultra')),
      harness_identity_observed INTEGER NOT NULL DEFAULT 0 CHECK (harness_identity_observed IN (0,1)),
      depth INTEGER NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, started_at TEXT,
      finished_at TEXT, activity TEXT, last_activity_at TEXT, child_session_id TEXT,
      acpx_record_id TEXT, result_tail TEXT, error TEXT,
      retry_of_run_id TEXT REFERENCES agent_runs(id),
      resume_of_run_id TEXT REFERENCES agent_runs(id), timeout_seconds INTEGER NOT NULL,
      CHECK (retry_of_run_id IS NULL OR resume_of_run_id IS NULL)
    );
    CREATE INDEX idx_agent_runs_status_created ON agent_runs(status, created_at);
    CREATE INDEX idx_agent_runs_child_session ON agent_runs(child_session_id) WHERE child_session_id IS NOT NULL;
    CREATE INDEX idx_agent_runs_parent_created ON agent_runs(parent_thread_id, created_at DESC) WHERE parent_thread_id IS NOT NULL;
    INSERT INTO agent_runs (
      id,harness,task,cwd,effort,depth,status,created_at,retry_of_run_id,timeout_seconds
    ) VALUES (
      'broken-retry','codex','must roll back','/tmp/repo','xhigh',1,'failed',
      '2026-07-01T00:00:00.000Z','missing-run',3600
    );
  `);
  prior.close();

  assert.throws(
    () => new ThreadDb(dbPath),
    /foreign key/i,
    "every agent_runs rebuild validates copied relationships before commit",
  );

  const inspect = new DatabaseSync(dbPath);
  const tableSql = (inspect.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_runs'",
  ).get() as { sql: string }).sql;
  assert.ok(
    tableSql.includes("effort TEXT CHECK (effort IS NULL OR effort IN ('minimal','low','medium','high','xhigh'))"),
    "failed rebuild rolls back the original effort constraint",
  );
  assert.equal(
    (inspect.prepare("SELECT task FROM agent_runs WHERE id='broken-retry'").get() as { task: string }).task,
    "must roll back",
    "failed rebuild preserves original data",
  );
  const indexNames = (inspect.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_agent_runs_%' ORDER BY name",
  ).all() as Array<{ name: string }>).map(({ name }) => name);
  assert.deepEqual(indexNames, [
    "idx_agent_runs_child_session",
    "idx_agent_runs_parent_created",
    "idx_agent_runs_status_created",
  ], "failed rebuild restores the original indexes");
  inspect.close();
} finally {
  rmSync(failedRebuildDir, { recursive: true, force: true });
}

process.stdout.write("ok — failed agent_runs rebuild rolls back schema, data, and indexes\n");
