import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentRunHarness,
  AgentRunStatus,
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
import { createDelegateAgentTool } from "./tools/delegate-agent";
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
  query: {} as never,
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
      ordering.push("delegate_agent");
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
  const delegateAgent = createDelegateAgentTool({ resolveGateway: async () => client });
  let threadId = "same-turn-root";
  const context = {
    cwd: fallbackCwd,
    sessionManager: { getSessionId: () => threadId },
  } as Parameters<typeof delegateAgent.execute>[4];

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

  const delegated = await delegateAgent.execute("delegate-same-turn", {
    harness: AgentRunHarness.Codex,
    task: "work in the just-selected checkout",
  }, undefined, undefined, context);
  assert.equal(delegated.details.cwd, selectedPath,
    "omitted child cwd observes the durable selection before post-turn runtime rebind");
  assert.equal(launches[0]?.parentThreadId, threadId, "selection resolution and launch use the exact root identity");
  assert.deepEqual(ordering, ["use_worktree", "resolve_worktree_cwd", "delegate_agent"],
    "selection resolution occurs immediately before same-turn delegation");

  git.mismatch = true;
  await assert.rejects(() => delegateAgent.execute("delegate-mismatched", {
    harness: AgentRunHarness.Codex,
    task: "must not fall back after selection mismatch",
  }, undefined, undefined, context), /selected worktree is unavailable or has changed Git identity/);
  assert.equal(launches.length, 1, "a mismatched durable selection fails closed before launch");
  assert.equal(state.selectedWorktree(threadId)?.path, selectedPath, "failed validation preserves selection for diagnosis");

  git.mismatch = false;
  threadId = "unselected-root";
  const unselected = await delegateAgent.execute("delegate-unselected", {
    harness: AgentRunHarness.Codex,
    task: "use the active fallback when no selection exists",
  }, undefined, undefined, context);
  assert.equal(unselected.details.cwd, fallbackCwd, "a root without a selection retains ctx.cwd");
  client.close();
  process.stdout.write("ok — same-turn worktree selection wins for omitted delegated cwd\n");
} finally {
  await gateway.close();
  state.close();
  if (previousOoHome === undefined) delete process.env.OO_HOME;
  else process.env.OO_HOME = previousOoHome;
  rmSync(root, { recursive: true, force: true });
}
