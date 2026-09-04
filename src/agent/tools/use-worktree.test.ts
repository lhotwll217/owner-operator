import assert from "node:assert/strict";
import type {
  GatewayApi,
  RegisteredWorktree,
  UseWorktreeRequest,
  UseWorktreeResult,
} from "@owner-operator/core";
import { createUseWorktreeTool } from "./use-worktree";

const row: RegisteredWorktree = {
  id: "worktree-04",
  repository: "owner-operator",
  path: "/oo/worktrees/owner-operator/issue-131",
  gitCommonDir: "/repos/owner-operator/.git",
  createdByThreadId: "creating-root",
  createdAt: "2026-09-04T12:00:00.000Z",
};
const calls: UseWorktreeRequest[] = [];
const selections: string[] = [];
const backend = {
  async useWorktree(request: UseWorktreeRequest): Promise<UseWorktreeResult> {
    calls.push(request);
    if (request.input.action === "list") return { action: "list", worktrees: [] };
    if (request.input.action === "select") {
      return { action: "select", worktree: { ...row, available: true, selected: true } };
    }
    return { action: "create", created: true, worktree: { ...row, available: true, selected: true } };
  },
} as Pick<GatewayApi, "useWorktree">;
const tool = createUseWorktreeTool({
  resolveGateway: async () => backend,
  onSelection: (threadId) => selections.push(threadId),
});

assert.match(tool.description, /create, list, or select/i);
assert.match(tool.description, /root identity.*active session automatically/i,
  "the description states the trusted identity source without asking the model for mechanics");
assert.match(tool.description, /does not remove or clean up/i);
assert.doesNotMatch(JSON.stringify(tool.parameters), /threadId|thread_id/,
  "the model-facing schema cannot supply or spoof root identity");

const context = (threadId: string) => ({
  sessionManager: { getSessionId: () => threadId },
}) as Parameters<typeof tool.execute>[4];

await tool.execute("create", {
  action: "create",
  repository: "/repos/owner-operator",
  name: "issue-131",
}, undefined, undefined, context("creating-root"));
await tool.execute("list", { action: "list" }, undefined, undefined, context("later-root"));
await tool.execute("select", {
  action: "select",
  worktreeId: row.id,
}, undefined, undefined, context("later-root"));

assert.deepEqual(calls, [
  {
    threadId: "creating-root",
    input: { action: "create", repository: "/repos/owner-operator", name: "issue-131" },
  },
  { threadId: "later-root", input: { action: "list" } },
  { threadId: "later-root", input: { action: "select", worktreeId: row.id } },
], "every action derives the live runtime session id at execution time");
assert.deepEqual(selections, ["creating-root", "later-root"],
  "only successful create/select operations record a pending runtime change");

process.stdout.write("ok — use_worktree derives root identity from tool context\n");
