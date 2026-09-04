import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitWorktreeAdapter, parseWorktreePorcelain } from "./git";

const root = mkdtempSync(join(tmpdir(), "oo git adapter "));
const repositoryPath = join(root, "repository with spaces");
const targetPath = join(root, "worktree;argv-safe");
const marker = join(root, "must-not-exist");
const git = (...args: string[]): string => execFileSync("git", args, { encoding: "utf8" }).trim();

try {
  mkdirSync(repositoryPath, { recursive: true });
  git("-C", repositoryPath, "init", "-b", "main");
  git("-C", repositoryPath, "config", "user.email", "fixture@example.com");
  git("-C", repositoryPath, "config", "user.name", "Fixture");
  writeFileSync(join(repositoryPath, "README.md"), "fixture\n");
  git("-C", repositoryPath, "add", "README.md");
  git("-C", repositoryPath, "commit", "-m", "fixture");

  assert.deepEqual(parseWorktreePorcelain(
    "worktree /repo/main\0HEAD abc\0branch refs/heads/main\0\0" +
    "worktree /repo/linked\nname\0HEAD def\0detached\0\0",
  ), [
    { path: "/repo/main", branch: "refs/heads/main", bare: false },
    { path: "/repo/linked\nname", branch: null, bare: false },
  ], "NUL porcelain preserves unusual path bytes and record boundaries");

  const adapter = new GitWorktreeAdapter();
  const repository = await adapter.resolveRepository(repositoryPath);
  assert.equal(repository.repository, "repository with spaces");
  await adapter.createWorktree(repository, targetPath, "feature;argv-safe");
  const inspected = await adapter.inspectWorktree(targetPath);
  assert.equal(inspected.path, realpathSync.native(targetPath));
  assert.equal(inspected.branch, "refs/heads/feature;argv-safe");
  assert.equal(inspected.gitCommonDir, repository.gitCommonDir);
  assert.equal(inspected.main, false);

  await assert.rejects(
    () => adapter.createWorktree(
      repository,
      join(root, "injected"),
      `unsafe;touch ${marker}`,
    ),
  );
  assert.equal(existsSync(marker), false, "caller values are argv data and never shell syntax");
  process.stdout.write("ok — Git worktree adapter uses argv-safe stable topology inspection\n");
} finally {
  rmSync(root, { recursive: true, force: true });
}
