import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentRunStatus,
  type AgentRun,
  type AgentRunCreateInput,
  type DaemonHealth,
  type DaemonReady,
  type UseWorktreeResult,
} from "@owner-operator/core";
import { agentRunFixture } from "../../test/fixtures/agent-run";
import { connectGateway } from "../gateway/client";
import { startGateway } from "../gateway/server";
import { State } from "../state/state";
import { GitWorktreeAdapter, type GitRepositoryIdentity } from "../worktrees/git";
import { WorktreeService } from "../worktrees/worktrees";
import { repoRoot } from "../shared/repo-root";
import { createUseWorktreeTool } from "./tools/use-worktree";

const root = mkdtempSync(join(tmpdir(), "oo-same-turn-worktree-delegation-"));
const previousOoHome = process.env.OO_HOME;
const ooHome = join(root, "oo-home");
const repositoryPath = join(root, "repository");
const fallbackCwd = join(root, "stale-runtime-cwd");
const gitCommonDir = join(repositoryPath, ".git");
for (const path of [ooHome, repositoryPath, fallbackCwd]) mkdirSync(path, { recursive: true });
process.env.OO_HOME = ooHome;

class FixtureGitAdapter extends GitWorktreeAdapter {
  mismatch = false;

  override async resolveRepository(): Promise<GitRepositoryIdentity> {
    return { repository: "fixture-repository", root: repositoryPath, gitCommonDir };
  }

  override async createWorktree(
    _repository: GitRepositoryIdentity,
    targetPath: string,
  ): Promise<void> {
    mkdirSync(targetPath, { recursive: true });
  }

  override async inspectWorktree(path: string) {
    return {
      repository: "fixture-repository",
      root: repositoryPath,
      gitCommonDir: this.mismatch ? join(repositoryPath, "different.git") : gitCommonDir,
      path,
      branch: "refs/heads/ticket-07",
      main: false,
    };
  }
}

const state = new State(join(ooHome, "state.db"));
const git = new FixtureGitAdapter();
const worktrees = new WorktreeService(state, { ooHome, git });
const launches: AgentRunCreateInput[] = [];
const ordering: string[] = [];
let port = 0;
const health = (): DaemonHealth => ({
  ok: true, port, pid: process.pid, startedAt: "now", fingerprint: "same-turn-test", stale: false,
});
const ready = (): DaemonReady => ({
  ready: true,
  setupRequired: false,
  modules: { state: true, sessionMonitor: true, scheduler: true, gateway: true },
});
const gateway = await startGateway({
  authToken: "token",
  state,
  monitor: { poll: async () => undefined },
  scheduler: {} as never,
  query: {} as never, harness: {} as never, search: {} as never,
  worktrees: {
    use: async (request) => {
      ordering.push("use_worktree");
      return worktrees.use(request);
    },
    resolveCwd: async (request) => {
      ordering.push("resolve_worktree_cwd");
      return worktrees.resolveCwd(request);
    },
  },
  agentRuns: {
    launch(input: AgentRunCreateInput) {
      ordering.push("oo runs delegate");
      launches.push(input);
      return agentRunFixture(`run-${launches.length}`, AgentRunStatus.Pending, {
        ...input,
        parentThreadId: input.parentThreadId ?? null,
        model: input.model ?? null,
        effort: input.effort ?? null,
      });
    },
  } as never,
  health,
  ready,
  port: 0,
});
port = gateway.port;

try {
  writeFileSync(join(ooHome, "daemon.json"), JSON.stringify({
    port,
    pid: process.pid,
    startedAt: "now",
    fingerprint: "same-turn-test",
    authToken: "token",
  }));
  const client = await connectGateway();
  assert.ok(client);
  const useWorktree = createUseWorktreeTool({ resolveGateway: async () => client });
  let threadId = "same-turn-root";
  const context = {
    cwd: fallbackCwd,
    sessionManager: { getSessionId: () => threadId },
  } as Parameters<typeof useWorktree.execute>[4];
  // The Operator's bash: the privacy guard exports its session id and OO_AGENT=1, and the shell's
  // cwd is the turn's pre-selection cwd. Asynchronous, so this process's Gateway can answer.
  const delegate = (task: string) => new Promise<{ status: number; stderr: string; run: AgentRun | null }>((done) => {
    const env = { ...process.env, OO_HOME: ooHome, OO_AGENT: "1", OO_CURRENT_SESSION_ID: threadId };
    execFile(join(repoRoot, "oo"), ["runs", "delegate", "--harness", "codex", "--json", task], {
      cwd: fallbackCwd, env, encoding: "utf8",
    }, (error, stdout, stderr) => {
      const status = error ? Number(error.code ?? 1) : 0;
      done({ status, stderr, run: status === 0 ? JSON.parse(stdout) as AgentRun : null });
    });
  });

  const created = await useWorktree.execute("create-worktree", {
    action: "create",
    repository: repositoryPath,
    name: "ticket-07",
  }, undefined, undefined, context);
  const createdDetails = created.details as UseWorktreeResult;
  const selectedPath = createdDetails.action === "create" ? createdDetails.worktree.path : "";
  assert.equal(state.selectedWorktree(threadId)?.path, selectedPath,
    "use_worktree persists the exact root selection through Gateway and State");
  assert.equal(context.cwd, fallbackCwd, "the selecting turn still has its pre-selection Pi tool context");

  const delegated = await delegate("work in the just-selected checkout");
  assert.equal(delegated.status, 0, delegated.stderr);
  assert.equal(delegated.run?.cwd, selectedPath,
    "omitted child cwd observes the durable selection before post-turn runtime rebind");
  assert.equal(launches[0]?.parentThreadId, threadId, "selection resolution and launch use the exact root identity");
  assert.deepEqual(ordering, ["use_worktree", "resolve_worktree_cwd", "oo runs delegate"],
    "selection resolution occurs immediately before same-turn delegation");

  git.mismatch = true;
  const mismatched = await delegate("must not fall back after selection mismatch");
  assert.equal(mismatched.status, 1);
  assert.match(mismatched.stderr, /selected worktree is unavailable or has changed Git identity/);
  assert.equal(launches.length, 1, "a mismatched durable selection fails closed before launch");
  assert.equal(state.selectedWorktree(threadId)?.path, selectedPath, "failed validation preserves selection for diagnosis");

  git.mismatch = false;
  threadId = "unselected-root";
  const unselected = await delegate("use the active fallback when no selection exists");
  assert.equal(unselected.run?.cwd, realpathSync(fallbackCwd), "a root without a selection retains the shell cwd");
  client.close();
  process.stdout.write("ok — same-turn worktree selection wins for omitted delegated cwd\n");
} finally {
  await gateway.close();
  state.close();
  if (previousOoHome === undefined) delete process.env.OO_HOME;
  else process.env.OO_HOME = previousOoHome;
  rmSync(root, { recursive: true, force: true });
}
