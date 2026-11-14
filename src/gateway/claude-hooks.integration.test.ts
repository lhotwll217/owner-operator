// Claude hook payloads through POST /hooks/claude, asserted on GET /session-state.
import assert from "node:assert/strict";
import { join } from "node:path";
import { AgentRunHarness, type SessionStateRow } from "@owner-operator/core";
import { State } from "../state/state";
import { startGateway } from "./server";
import { fakeScanRow, tempOoHome } from "./test/helpers";

const { dir, cleanup } = tempOoHome("oo-claude-hooks");
const state = new State(join(dir, "state.db"), { now: () => new Date().toISOString() });
const gateway = await startGateway({
  authToken: "test-token", state, port: 0,
  monitor: { poll: async () => [] },
  health: () => ({ ok: true, port: gateway.port, pid: process.pid, startedAt: "now", fingerprint: "test", stale: false, repoRoot: "/test" }),
  ready: () => ({ ready: true, setupRequired: false, modules: { state: true, sessionMonitor: true, scheduler: true, gateway: true } }),
  scheduler: {} as never, agentRuns: {} as never, worktrees: {} as never, query: {} as never, harness: {} as never, search: {} as never,
});
const endpoint = `http://127.0.0.1:${gateway.port}`;

async function post(harness: string, body: unknown, token = "test-token"): Promise<Response> {
  return fetch(`${endpoint}/hooks/${harness}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function rows(): Promise<SessionStateRow[]> {
  const response = await fetch(`${endpoint}/session-state`, { headers: { authorization: "Bearer test-token" } });
  assert.equal(response.status, 200);
  return response.json() as Promise<SessionStateRow[]>;
}

const row = async (id: string): Promise<SessionStateRow> => {
  const found = (await rows()).find((item) => item.id === id);
  assert.ok(found, `${id} is on the session list`);
  return found;
};

const claude = (sessionId: string, hook: Record<string, unknown>) => post("claude", {
  session_id: sessionId,
  cwd: "/work/owner-operator",
  transcript_path: `/tmp/${sessionId}.jsonl`,
  ...hook,
});

try {
  assert.equal((await post("claude", { session_id: "s", hook_event_name: "Stop" }, "nope")).status, 401);
  assert.equal((await post("codex", { session_id: "s", hook_event_name: "Stop" })).status, 404);
  assert.equal((await claude("perm-session", { hook_event_name: "Notification" })).status, 204);

  await claude("perm-session", { hook_event_name: "UserPromptSubmit", prompt: "rename the export" });
  // Only this PreToolUse carries the id the ask that follows is about.
  await claude("perm-session", {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_use_id: "toolu_bash",
    tool_input: { command: "ls" },
  });
  await claude("perm-session", {
    hook_event_name: "PermissionRequest",
    tool_name: "Bash",
    tool_input: { command: "ls" },
  });
  await claude("perm-session", {
    hook_event_name: "PreToolUse",
    tool_name: "Read",
    tool_use_id: "toolu_read",
    tool_input: { file_path: "README.md" },
  });
  assert.equal((await row("perm-session")).state, "needs-you", "a permission stays up through a later unrelated tool");

  const live = await row("perm-session");
  state.recordObservation(fakeScanRow({
    id: "perm-session",
    source: "claude",
    working: false,
    lastRole: "assistant",
    lastMessageAt: live.lastMessageAt ?? "2026-11-13T00:00:00.000Z",
  }));
  assert.equal((await row("perm-session")).state, "needs-you", "a poll that would derive idle does not replace the hook");

  await claude("perm-session", { hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "toolu_bash" });
  assert.equal((await row("perm-session")).state, "working", "the permission's own tool finishing clears it");

  await claude("ask-session", { hook_event_name: "UserPromptSubmit", prompt: "which name?" });
  await claude("ask-session", {
    hook_event_name: "PreToolUse",
    tool_name: "AskUserQuestion",
    tool_use_id: "toolu_ask",
    tool_input: { questions: [{ question: "Which name?", header: "Name", options: [] }] },
  });
  assert.equal((await row("ask-session")).state, "needs-you");
  await claude("ask-session", { hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: "toolu_read_2" });
  assert.equal((await row("ask-session")).state, "working", "AskUserQuestion clears on the next unrelated tool");

  await claude("prompt-session", { hook_event_name: "UserPromptSubmit", prompt: "start" });
  await claude("prompt-session", { hook_event_name: "PermissionRequest", tool_name: "Edit" });
  await claude("prompt-session", { hook_event_name: "UserPromptSubmit", prompt: "do the other thing" });
  assert.equal((await row("prompt-session")).state, "working", "a new owner prompt clears a permission");

  await claude("child-session-native", { hook_event_name: "UserPromptSubmit", prompt: "explore" });
  await claude("child-session-native", {
    hook_event_name: "PermissionRequest",
    tool_name: "Bash",
    agent_id: "agent_1",
  });
  await claude("child-session-native", { hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: "toolu_other" });
  assert.equal((await row("child-session-native")).state, "needs-you");
  await claude("child-session-native", { hook_event_name: "SubagentStop", agent_id: "agent_1" });
  assert.equal((await row("child-session-native")).state, "working", "the owning child ending clears its permission");

  state.recordObservation(fakeScanRow({ id: "parent-session", working: true, lastRole: "user", source: "claude" }));
  state.createAgentRun({
    harness: AgentRunHarness.ClaudeCode,
    task: "rename the export",
    cwd: "/work/owner-operator",
    parentThreadId: "parent-session",
    childSessionId: "delegated-child",
    depth: 1,
    timeoutSeconds: 60,
  });
  await claude("delegated-child", { hook_event_name: "UserPromptSubmit", prompt: "rename the export" });
  await claude("delegated-child", { hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "ls" } });
  assert.equal((await row("delegated-child")).state, "needs-you");
  assert.equal((await row("parent-session")).state, "needs-you", "a delegated child's permission is Need You on the parent too");
  assert.equal((await row("delegated-child")).parentThreadId, "parent-session");

  await claude("parallel-session", { hook_event_name: "UserPromptSubmit", prompt: "check both trees" });
  await claude("parallel-session", {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_use_id: "toolu_ls",
    tool_input: { command: "ls" },
  });
  await claude("parallel-session", {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_use_id: "toolu_pwd",
    tool_input: { command: "pwd" },
  });
  await claude("parallel-session", {
    hook_event_name: "PermissionRequest",
    tool_name: "Bash",
    tool_input: { command: "pwd" },
    permission_suggestions: [],
  });
  await claude("parallel-session", { hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "toolu_ls" });
  assert.equal(
    (await row("parallel-session")).state,
    "needs-you",
    "one of two parallel Bash calls finishing does not answer the permission",
  );
  await claude("parallel-session", {
    hook_event_name: "PostToolBatch",
    tool_calls: [{ tool_name: "Bash", tool_use_id: "toolu_pwd", tool_response: "denied" }],
  });
  assert.equal((await row("parallel-session")).state, "working", "the batch end resolves the asked call");

  state.createAgentRun({
    harness: AgentRunHarness.ClaudeCode,
    task: "update the changelog",
    cwd: "/work/owner-operator",
    parentThreadId: "hooked-parent",
    childSessionId: "quiet-child",
    depth: 1,
    timeoutSeconds: 60,
  });
  await claude("hooked-parent", { hook_event_name: "UserPromptSubmit", prompt: "update the changelog" });
  await claude("hooked-parent", { hook_event_name: "Stop" });
  assert.equal(
    (await row("hooked-parent")).state,
    "working",
    "a hooked parent whose own turn stopped stays working while its delegated child runs",
  );
  await claude("hooked-parent", { hook_event_name: "UserPromptSubmit", prompt: "and the version" });
  await claude("hooked-parent", {
    hook_event_name: "PreToolUse",
    tool_name: "Write",
    tool_use_id: "toolu_version",
    tool_input: { file_path: "package.json", content: "{}" },
  });
  await claude("hooked-parent", {
    hook_event_name: "PermissionRequest",
    tool_name: "Write",
    tool_input: { file_path: "package.json", content: "{}" },
  });
  assert.equal(
    (await row("hooked-parent")).state,
    "needs-you",
    "the parent's own permission outranks its running delegated child",
  );

  await claude("compact-session", { hook_event_name: "UserPromptSubmit", prompt: "summarize the log" });
  await claude("compact-session", {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_use_id: "toolu_tail",
    tool_input: { command: "tail -n 100 app.log" },
  });
  await claude("compact-session", {
    hook_event_name: "PermissionRequest",
    tool_name: "Bash",
    tool_input: { command: "tail -n 100 app.log" },
  });
  assert.equal((await row("compact-session")).state, "needs-you");
  await claude("compact-session", { hook_event_name: "SessionStart", source: "compact" });
  assert.equal(
    (await row("compact-session")).state,
    "needs-you",
    "a compaction keeps the permission the owner still has to answer",
  );
  await claude("compact-session", { hook_event_name: "SessionStart", source: "startup" });
  assert.equal((await row("compact-session")).state, "idle", "a session start with no prior turn does reset it");

  await claude("forked-session", { hook_event_name: "SessionStart", source: "fork" });
  assert.equal((await row("forked-session")).state, "idle", "a forked session is on the list before it says anything");

  console.log("ok - claude hooks drive session state");
} finally {
  await gateway.close();
  state.close();
  cleanup();
}
