import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { State } from "../state/state";
import { GitWorktreeAdapter, type GitRepositoryIdentity } from "./git";
import { WorktreeService, type WorktreeState } from "./worktrees";

const root = mkdtempSync(join(tmpdir(), "oo-worktree-service-"));
const ooHome = join(root, "oo-home");
const repositoryPath = join(root, "repository");
const dbPath = join(ooHome, "state.db");
const runGit = (...args: string[]): string => execFileSync("git", args, { encoding: "utf8" }).trim();

class CountingGitAdapter extends GitWorktreeAdapter {
  readonly createdNames: string[] = [];

  override async createWorktree(
    repository: GitRepositoryIdentity,
    targetPath: string,
    name: string,
    base?: string,
  ): Promise<void> {
    this.createdNames.push(name);
    return super.createWorktree(repository, targetPath, name, base);
  }
}

try {
  mkdirSync(ooHome, { recursive: true });
  mkdirSync(repositoryPath, { recursive: true });
  runGit("-C", repositoryPath, "init", "-b", "main");
  runGit("-C", repositoryPath, "config", "user.email", "fixture@example.com");
  runGit("-C", repositoryPath, "config", "user.name", "Fixture");
  writeFileSync(join(repositoryPath, "README.md"), "fixture\n");
  runGit("-C", repositoryPath, "add", "README.md");
  runGit("-C", repositoryPath, "commit", "-m", "fixture");

  let state = new State(dbPath, { now: () => "2026-09-04T12:00:00.000Z" });
  const git = new CountingGitAdapter();
  let ordinary = new WorktreeService(state, { ooHome, git });

  assert.deepEqual(await ordinary.resolveCwd({
    threadId: "unselected-root",
    fallbackCwd: "/invocation/fallback",
  }), { cwd: "/invocation/fallback", selected: false },
  "a root without a selection retains the invocation fallback");

  await assert.rejects(() => ordinary.use({
    threadId: "failed-root",
    input: { action: "create", repository: repositoryPath, name: "bad-base", base: "missing-ref" },
  }), /unknown revision|single revision|needed a single revision|ambiguous argument|bad revision/i);
  assert.deepEqual(state.listWorktrees(), [], "failed Git creation persists no State row");
  assert.equal(state.selectedWorktree("failed-root"), undefined);

  const outside = join(root, "outside-owner-root");
  const repositoryWorktrees = join(realpathSync.native(ooHome), "worktrees", "repository");
  mkdirSync(outside, { recursive: true });
  symlinkSync(outside, join(repositoryWorktrees, "escape"));
  await assert.rejects(() => ordinary.use({
    threadId: "escaping-root",
    input: { action: "create", repository: repositoryPath, name: "escape/branch" },
  }), /resolves outside/);
  assert.equal(existsSync(join(outside, "branch")), false,
    "a symlinked name segment cannot create outside the OO worktree root");

  let persistenceAttempts = 0;
  const flakyState: WorktreeState = {
    registerAndSelectWorktree(threadId, worktree) {
      persistenceAttempts += 1;
      if (persistenceAttempts === 1) throw new Error("simulated daemon persistence failure");
      return state.registerAndSelectWorktree(threadId, worktree);
    },
    selectWorktree: (threadId, worktreeId) => state.selectWorktree(threadId, worktreeId),
    worktreeById: (id) => state.worktreeById(id),
    selectedWorktree: (threadId) => state.selectedWorktree(threadId),
    listWorktrees: (repository) => state.listWorktrees(repository),
  };
  const service = new WorktreeService(flakyState, { ooHome, git });
  const expectedPath = join(realpathSync.native(ooHome), "worktrees", "repository", "feature", "131");
  await assert.rejects(() => service.use({
    threadId: "creating-root",
    input: { action: "create", repository: repositoryPath, name: "feature/131" },
  }), (error: unknown) => error instanceof Error &&
    error.message.includes(`worktree exists but is unselected at ${expectedPath}`) &&
    error.message.includes("simulated daemon persistence failure"));
  assert.equal(state.listWorktrees().length, 0, "persistence failure leaves the Git path unregistered");

  const retry = await service.use({
    threadId: "creating-root",
    input: { action: "create", repository: repositoryPath, name: "feature/131" },
  });
  assert.equal(retry.action, "create");
  assert.equal(retry.created, false, "retry recognizes the exact validated existing worktree");
  assert.equal(git.createdNames.filter((name) => name === "feature/131").length, 1,
    "retry does not invoke duplicate Git creation");
  const registered = retry.worktree;
  assert.equal(registered.path, expectedPath);

  const listed = await service.use({ threadId: "creating-root", input: { action: "list" } });
  assert.equal(listed.action, "list");
  assert.deepEqual(listed.worktrees.map(({ id, available, selected }) => ({ id, available, selected })), [
    { id: registered.id, available: true, selected: true },
  ]);

  const selected = await service.use({
    threadId: "later-root",
    input: { action: "select", worktreeId: registered.id },
  });
  assert.equal(selected.action, "select");
  assert.equal(state.selectedWorktree("later-root")?.id, registered.id,
    "another root selects the same registered worktree after live validation");

  assert.deepEqual(await ordinary.resolveCwd({
    threadId: "later-root",
    fallbackCwd: "/must-not-fall-back",
  }), { cwd: registered.path, selected: true, worktreeId: registered.id },
  "a selection overrides the invocation fallback only after live Git validation");

  state.close();
  state = new State(dbPath, { now: () => "2026-09-04T12:05:00.000Z" });
  ordinary = new WorktreeService(state, { ooHome, git });
  assert.equal((await ordinary.resolveCwd({
    threadId: "later-root",
    fallbackCwd: "/different-process-fallback",
  })).cwd, registered.path, "process/daemon restart restores the exact selected cwd from State");

  class MismatchedGitAdapter extends CountingGitAdapter {
    override async inspectWorktree(path: string) {
      return { ...await super.inspectWorktree(path), gitCommonDir: join(root, "different.git") };
    }
  }
  await assert.rejects(() => new WorktreeService(state, {
    ooHome,
    git: new MismatchedGitAdapter(),
  }).resolveCwd({
    threadId: "later-root",
    fallbackCwd: "/must-not-fall-back",
  }), /selected worktree is unavailable or has changed Git identity/,
  "Git-common-dir mismatch fails closed instead of using the invocation fallback");
  assert.equal(state.selectedWorktree("later-root")?.id, registered.id,
    "identity mismatch retains selection for diagnosis");

  renameSync(registered.path, `${registered.path}.missing`);
  const unavailable = await service.use({ threadId: "later-root", input: { action: "list" } });
  assert.equal(unavailable.action, "list");
  assert.equal(unavailable.worktrees[0]?.available, false, "list reports live absence without cleanup");
  await assert.rejects(() => service.use({
    threadId: "third-root",
    input: { action: "select", worktreeId: registered.id },
  }), /unavailable or has changed Git identity/);
  assert.equal(state.selectedWorktree("later-root")?.id, registered.id,
    "failed validation retains the prior durable selection for diagnosis");
  await assert.rejects(() => ordinary.resolveCwd({
    threadId: "later-root",
    fallbackCwd: "/must-not-fall-back",
  }), /selected worktree is unavailable or has changed Git identity/,
  "a missing selected worktree fails closed on startup without fallback");

  state.close();
  process.stdout.write("ok — worktree orchestration preserves failure ordering and retry idempotency\n");
} finally {
  rmSync(root, { recursive: true, force: true });
}
