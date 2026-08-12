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
      harness_effort TEXT CHECK (harness_effort IS NULL OR harness_effort IN ('minimal','low','medium','high','xhigh')),
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
  upgraded.close();
  const inspect = new DatabaseSync(dbPath);
  const indexNames = (inspect.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_agent_runs_%' ORDER BY name").all() as Array<{ name: string }>).map(({ name }) => name);
  assert.deepEqual(indexNames, ["idx_agent_runs_child_session", "idx_agent_runs_parent_created", "idx_agent_runs_status_created"], "constraint upgrade preserves every agent-run index");
  inspect.close();
} finally {
  rmSync(constrainedDir, { recursive: true, force: true });
}

process.stdout.write("ok — prior effort constraints upgrade for max and ultra without data/index loss\n");
