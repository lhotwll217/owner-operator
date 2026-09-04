import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  DaemonHealth,
  DaemonReady,
  ResolveWorktreeCwdRequest,
  ResolveWorktreeCwdResult,
  UseWorktreeRequest,
  UseWorktreeResult,
} from "@owner-operator/core";
import { State } from "../state/state";
import { connectGateway } from "./client";
import { startGateway } from "./server";

const root = mkdtempSync(join(tmpdir(), "oo-worktree-gateway-"));
const previousOoHome = process.env.OO_HOME;
process.env.OO_HOME = root;
const state = new State(join(root, "state.db"));
const calls: UseWorktreeRequest[] = [];
const resolutions: ResolveWorktreeCwdRequest[] = [];
let fail = false;
let port = 0;

const health = (): DaemonHealth => ({
  ok: true, port, pid: process.pid, startedAt: "now", fingerprint: "worktree-test", stale: false,
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
  agentRuns: {} as never,
  query: {} as never,
  worktrees: {
    async use(request): Promise<UseWorktreeResult> {
      calls.push(request);
      if (fail) throw new Error("worktree exists but is unselected at /exact/retry/path");
      return { action: "list", worktrees: [] };
    },
    async resolveCwd(request): Promise<ResolveWorktreeCwdResult> {
      resolutions.push(request);
      if (fail) throw new Error("selected worktree is unavailable at /exact/selected/path");
      return { cwd: request.fallbackCwd, selected: false };
    },
  },
  health,
  ready,
  port: 0,
});
port = gateway.port;

try {
  writeFileSync(join(root, "daemon.json"), JSON.stringify({
    port,
    pid: process.pid,
    startedAt: "now",
    fingerprint: "worktree-test",
    authToken: "token",
  }));
  const client = await connectGateway();
  assert.ok(client);
  const request: UseWorktreeRequest = { threadId: "root-04", input: { action: "list" } };
  assert.deepEqual(await client.useWorktree(request), { action: "list", worktrees: [] });
  assert.deepEqual(calls, [request], "Gateway transports one typed operation to the injected worktree module");
  const resolution: ResolveWorktreeCwdRequest = {
    threadId: "root-05",
    fallbackCwd: "/invocation/fallback",
  };
  assert.deepEqual(await client.resolveWorktreeCwd(resolution), {
    cwd: "/invocation/fallback",
    selected: false,
  });
  assert.deepEqual(resolutions, [resolution], "Gateway transports stable root identity with its invocation fallback");

  fail = true;
  await assert.rejects(
    () => client.useWorktree({
      threadId: "root-04",
      input: { action: "create", repository: "/repo", name: "retry" },
    }),
    /worktree exists but is unselected at \/exact\/retry\/path/,
    "Gateway client preserves the exact unselected path from daemon orchestration",
  );
  await assert.rejects(
    () => client.resolveWorktreeCwd(resolution),
    /selected worktree is unavailable at \/exact\/selected\/path/,
    "Gateway preserves fail-closed selected-worktree diagnostics",
  );
  client.close();
  process.stdout.write("ok — Gateway transports typed worktree operations and exact failures\n");
} finally {
  await gateway.close();
  state.close();
  if (previousOoHome === undefined) delete process.env.OO_HOME;
  else process.env.OO_HOME = previousOoHome;
  rmSync(root, { recursive: true, force: true });
}
