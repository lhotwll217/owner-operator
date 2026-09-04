// An ingested OO root crosses the public Gateway session-state boundary unchanged.
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DaemonHealth, DaemonReady, ScanRow } from "@owner-operator/core";
import { State } from "../state/state";
import { startGateway } from "./server";

const dir = mkdtempSync(join(tmpdir(), "oo-root-gateway-"));
process.env.OO_HOME = dir;
const state = new State(join(dir, "state.db"), {
  now: () => "2026-09-04T10:00:00.000Z",
  activeWindow: "1d",
});
const root: ScanRow = {
  id: "oo-root-gateway",
  source: "pi",
  repo: "issue-131",
  project: "/tasks/issue-131",
  app: "Owner Operator",
  topic: "Monitor the root",
  lastRole: "assistant",
  createdAt: "2026-09-04T09:00:00.000Z",
  lastMessageAt: "2026-09-04T09:59:00.000Z",
  secondsSinceLastMessage: 60,
  secondsSinceActivity: 60,
  working: false,
};
state.recordObservation(root);
state.registerAndSelectWorktree(root.id, {
  repository: "owner-operator",
  path: "/worktrees/owner-operator/ticket-07",
  gitCommonDir: "/repositories/owner-operator/.git",
});
const fallbackRoot: ScanRow = {
  ...root,
  id: "oo-root-gateway-unselected",
  repo: "issue-132",
  project: "/tasks/issue-132",
  topic: "Monitor an unselected root",
};
state.recordObservation(fallbackRoot);

const health = (): DaemonHealth => ({
  ok: true, port: 0, pid: process.pid, startedAt: "now", fingerprint: "test", stale: false,
});
const ready = (): DaemonReady => ({
  ready: true, setupRequired: false,
  modules: { state: true, sessionMonitor: true, scheduler: true, gateway: true },
});
const gateway = await startGateway({
  authToken: "token",
  state,
  monitor: { poll: async () => undefined },
  scheduler: {} as never,
  agentRuns: {} as never,
  worktrees: {} as never,
  query: {} as never,
  health,
  ready,
  port: 0,
});

try {
  const response = await fetch(`http://127.0.0.1:${gateway.port}/session-state`, {
    headers: { authorization: "Bearer token" },
  });
  assert.equal(response.status, 200);
  const rows = await response.json() as Array<Record<string, unknown>>;
  const selected = rows.find((row) => row.id === root.id);
  const fallback = rows.find((row) => row.id === fallbackRoot.id);
  assert.deepEqual(
    {
      id: selected?.id,
      source: selected?.source,
      repo: selected?.repo,
      project: selected?.project,
      app: selected?.app,
      parent: selected?.parentThreadId,
    },
    {
      id: root.id,
      source: "pi",
      repo: "owner-operator",
      project: "/worktrees/owner-operator/ticket-07",
      app: "Owner Operator",
      parent: null,
    },
    "Gateway exposes the selected worktree's recorded repository and path",
  );
  assert.deepEqual(
    { repo: fallback?.repo, project: fallback?.project },
    { repo: fallbackRoot.repo, project: fallbackRoot.project },
    "Gateway retains transcript provenance when the root has no worktree selection",
  );
  process.stdout.write("ok — OO root worktree projection crosses State → Gateway session-state\n");
} finally {
  await gateway.close();
  state.close();
  delete process.env.OO_HOME;
  rmSync(dir, { recursive: true, force: true });
}
