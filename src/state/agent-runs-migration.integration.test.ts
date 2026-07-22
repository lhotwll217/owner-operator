// Integration: open a pre-effort agent_runs database and prove the additive migration preserves
// unknown legacy intent as NULL rather than inventing an effort value.
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
