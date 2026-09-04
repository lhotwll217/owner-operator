import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DomainEventKind, type DomainEvent, type ScanRow } from "@owner-operator/core";
import { State } from "./state";

const root = mkdtempSync(join(tmpdir(), "oo-state-worktrees-"));
const dbPath = join(root, "state.db");
const events: DomainEvent[] = [];
const state = new State(dbPath, { now: () => "2026-09-04T12:00:00.000Z" });
state.bus.subscribe((event) => { events.push(event); });
const observation = (id: string): ScanRow => ({
  id,
  source: "pi",
  repo: "transcript-repository",
  project: "/transcript/task/path",
  app: "Owner Operator",
  topic: "Selected workspace projection",
  lastRole: "assistant",
  createdAt: "2026-09-04T11:00:00.000Z",
  lastMessageAt: "2026-09-04T11:59:00.000Z",
  secondsSinceLastMessage: 60,
  secondsSinceActivity: 60,
  working: false,
});

try {
  const first = state.registerAndSelectWorktree("root-before-ingestion", {
    repository: "owner-operator",
    path: "/canonical/worktrees/first",
    gitCommonDir: "/canonical/repository/.git",
  });
  assert.equal(first.createdByThreadId, "root-before-ingestion");
  assert.equal(state.selectedWorktree("root-before-ingestion")?.id, first.id,
    "selection succeeds before asynchronous thread ingestion");

  const second = state.registerAndSelectWorktree("root-before-ingestion", {
    repository: "owner-operator",
    path: "/canonical/worktrees/second",
    gitCommonDir: "/canonical/repository/.git",
  });
  assert.equal(state.selectedWorktree("root-before-ingestion")?.id, second.id,
    "one root selection is replaced rather than appended");
  assert.equal(state.listWorktrees().length, 2, "both OO creation records remain registered");

  state.recordObservation(observation("root-before-ingestion"));
  state.recordObservation(observation("unselected-root"));
  const projected = new Map(state.listSessionState().map((row) => [row.id, row]));
  assert.deepEqual(
    { repo: projected.get("root-before-ingestion")?.repo, project: projected.get("root-before-ingestion")?.project },
    { repo: second.repository, project: second.path },
    "a durable selection overrides transcript repository and project even when State cannot inspect its path",
  );
  assert.deepEqual(
    { repo: projected.get("unselected-root")?.repo, project: projected.get("unselected-root")?.project },
    { repo: "transcript-repository", project: "/transcript/task/path" },
    "an unselected root retains transcript provenance in the session projection",
  );

  state.selectWorktree("later-root", first.id);
  assert.equal(state.selectedWorktree("later-root")?.id, first.id,
    "a later root may select the same OO-created worktree");

  const reused = state.registerAndSelectWorktree("retry-root", {
    repository: first.repository,
    path: first.path,
    gitCommonDir: first.gitCommonDir,
  });
  assert.equal(reused.id, first.id, "the exact canonical path reuses one creation record");
  assert.equal(reused.createdByThreadId, first.createdByThreadId,
    "retry does not rewrite original creation provenance");

  const raw = new DatabaseSync(dbPath);
  try {
    const columns = (raw.prepare("PRAGMA table_info(worktrees)").all() as Array<{ name: string }>)
      .map(({ name }) => name);
    assert.deepEqual(columns, [
      "id", "repository", "path", "git_common_dir", "created_by_thread_id", "created_at",
    ], "State does not duplicate mutable Git branch, HEAD, dirty, or topology facts");
    const foreignKeys = raw.prepare("PRAGMA foreign_key_list(thread_worktrees)").all() as Array<{
      from: string; table: string;
    }>;
    assert.deepEqual(foreignKeys.map(({ from, table }) => [from, table]), [["worktree_id", "worktrees"]],
      "thread selection intentionally has no asynchronous-ingestion foreign key");

    raw.exec(`CREATE TRIGGER fail_test_selection BEFORE INSERT ON thread_worktrees
      WHEN NEW.thread_id = 'rollback-root'
      BEGIN SELECT RAISE(ABORT, 'forced selection failure'); END`);
    assert.throws(() => state.registerAndSelectWorktree("rollback-root", {
      repository: "owner-operator",
      path: "/canonical/worktrees/rolled-back",
      gitCommonDir: "/canonical/repository/.git",
    }), /forced selection failure/);
    assert.equal(
      (raw.prepare("SELECT COUNT(*) AS count FROM worktrees WHERE path = ?")
        .get("/canonical/worktrees/rolled-back") as { count: number }).count,
      0,
      "a selection failure rolls back the registry insert in the same transaction",
    );
  } finally {
    raw.close();
  }

  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(events.some((event) => event.kind === DomainEventKind.WorktreeChanged),
    "committed selection publishes the existing state-invalidation class");
  process.stdout.write("ok — State worktree provenance and root selection are atomic\n");
} finally {
  state.close();
  rmSync(root, { recursive: true, force: true });
}
