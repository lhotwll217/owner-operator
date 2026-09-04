import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AgentRunHarness, type ScanRow } from "@owner-operator/core";
import { State } from "./state";

const root = mkdtempSync(join(tmpdir(), "oo-worktree-migration-"));
const dbPath = join(root, "state.db");
const observation: ScanRow = {
  id: "preserved-thread",
  source: "pi",
  repo: "owner-operator",
  project: "/tasks/owner-operator",
  app: "Owner Operator",
  topic: "Preserve me",
  lastRole: "assistant",
  createdAt: "2026-09-04T09:00:00.000Z",
  lastMessageAt: "2026-09-04T09:01:00.000Z",
  secondsSinceLastMessage: 60,
  secondsSinceActivity: 60,
  working: false,
};

try {
  const prior = new State(dbPath, { now: () => "2026-09-04T10:00:00.000Z" });
  prior.recordObservation(observation);
  const run = prior.createAgentRun({
    harness: AgentRunHarness.Codex,
    task: "preserve run",
    cwd: root,
    parentThreadId: observation.id,
    model: "fixture-model",
    depth: 1,
    timeoutSeconds: 60,
  });
  prior.close();

  const legacy = new DatabaseSync(dbPath);
  legacy.exec("DROP TABLE thread_worktrees; DROP TABLE worktrees");
  legacy.close();

  const migrated = new State(dbPath, { now: () => "2026-09-04T11:00:00.000Z" });
  assert.equal(migrated.listSessionState().some(({ id }) => id === observation.id), true,
    "existing thread and detail rows survive the additive migration");
  assert.equal(migrated.agentRunById(run.id)?.task, run.task,
    "existing delegated-run data survives the additive migration");
  assert.deepEqual(migrated.listWorktrees(), [], "new registry starts empty on an existing database");
  migrated.close();

  const raw = new DatabaseSync(dbPath, { readOnly: true });
  const tables = new Set((raw.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table'",
  ).all() as Array<{ name: string }>).map(({ name }) => name));
  raw.close();
  assert.ok(tables.has("worktrees") && tables.has("thread_worktrees"),
    "opening the prior database creates both new tables");
  process.stdout.write("ok — worktree migration preserves existing State data\n");
} finally {
  rmSync(root, { recursive: true, force: true });
}
