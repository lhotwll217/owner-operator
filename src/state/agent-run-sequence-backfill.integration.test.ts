// Integration: a run log stored before the per-run sequence counter existed gets its counter from
// its stored rows on open, so the log is never mistaken for a legacy (unlogged) run and numbering
// continues after its last stored record.
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ThreadDb } from "./database";

const dir = mkdtempSync(join(tmpdir(), "oo-seq-backfill-"));
const path = join(dir, "state.db");
try {
  new ThreadDb(path).close();
  const raw = new DatabaseSync(path);
  raw.exec(`INSERT INTO agent_runs (id, harness, task, cwd, depth, status, created_at, finished_at, timeout_seconds)
    VALUES ('old-run', 'claude-code', 't', '/tmp', 1, 'completed', '2026-09-20T00:00:00Z', '2026-09-20T00:01:00Z', 60)`);
  raw.exec(`INSERT INTO agent_run_events VALUES
    ('old-run', 1, 'x', '{"type":"text_delta","text":"hi"}', 30),
    ('old-run', 2, 'x', '{"type":"result","runId":"old-run","status":"completed"}', 60)`);
  raw.close();

  const reopened = new ThreadDb(path);
  assert.equal(reopened.agentRunLastSeq("old-run"), 2, "the counter is backfilled from the stored log");
  assert.equal(reopened.agentRunLastSeq("never-logged"), null, "a run with no log stays legacy");
  reopened.close();
} finally {
  rmSync(dir, { recursive: true, force: true });
}

process.stdout.write("ok — pre-counter run logs get their sequence counter on open\n");
