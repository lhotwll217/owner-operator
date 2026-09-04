import assert from "node:assert";
import { resolve } from "node:path";
import {
  AgentRunHarness,
  AgentRunStatus,
  type AgentRunCreateInput,
  type GatewayApi,
  type ResolveWorktreeCwdRequest,
} from "@owner-operator/core";
import { agentRunFixture as run } from "../../../test/fixtures/agent-run";
import { createDelegateAgentTool } from "./delegate-agent";

const inputs: AgentRunCreateInput[] = [];
const resolutions: ResolveWorktreeCwdRequest[] = [];
let resolutionError: Error | undefined;
const backend = {
  async resolveWorktreeCwd(request: ResolveWorktreeCwdRequest) {
    resolutions.push(request);
    if (resolutionError) throw resolutionError;
    return request.threadId === "parent-thread"
      ? { cwd: "/durably-selected/root-worktree", selected: true as const, worktreeId: "worktree-07" }
      : { cwd: request.fallbackCwd, selected: false as const };
  },
  async delegateAgent(input: AgentRunCreateInput) {
    inputs.push(input);
    return run(`run-${inputs.length}`, AgentRunStatus.Pending, {
      harness: input.harness,
      task: input.task,
      cwd: input.cwd,
      parentThreadId: input.parentThreadId ?? null,
      model: input.model ?? null,
      effort: input.effort ?? null,
    });
  },
  async waitAgentRun() { throw new Error("wait not expected"); },
} as Pick<GatewayApi, "delegateAgent" | "resolveWorktreeCwd" | "waitAgentRun">;
const tool = createDelegateAgentTool({ resolveGateway: async () => backend });
assert.match(tool.description, /do not poll/i, "the tool tells the Operator that completion is delivered automatically");
assert.match(tool.description, /omits model or effort.*MUST follow.*select-harness-for-delegation/i,
  "implicit delegation cannot use approved-baseline omission to bypass current harness details");
const effortSchema = (tool.parameters as { properties: { effort: { anyOf: Array<{ type?: string }> } } }).properties.effort;
assert.ok(effortSchema.anyOf.some((option) => option.type === "null"), "the public schema accepts explicit null effort");
const effortLiterals = (effortSchema.anyOf as Array<{ const?: string }>).flatMap((option) => option.const ? [option.const] : []);
assert.ok(effortLiterals.includes("max") && effortLiterals.includes("ultra"), "the public schema exposes every advertised Codex effort");
const parameters = tool.parameters as {
  properties: { cwd: { description?: string } };
  required?: string[];
};
assert.ok(!parameters.required?.includes("cwd"), "cwd remains optional in the public schema");
assert.match(parameters.properties.cwd.description ?? "", /defaults to the caller's cwd/i);
const activeToolCwd = "/selected/root-worktree";
const context = {
  cwd: activeToolCwd,
  sessionManager: { getSessionId: () => "parent-thread" },
} as Parameters<typeof tool.execute>[4];

await tool.execute("omitted-cwd", {
  harness: AgentRunHarness.ClaudeCode,
  task: "inherit the active root workspace",
}, undefined, undefined, context);
assert.equal(inputs[0]?.cwd, "/durably-selected/root-worktree",
  "a durable selection overrides a stale active tool context in the same turn");
assert.equal(inputs[0]?.parentThreadId, "parent-thread", "cwd inheritance does not replace root session identity");
assert.deepEqual(resolutions[0], { threadId: "parent-thread", fallbackCwd: activeToolCwd },
  "omitted cwd resolves the exact root selection with the active context as fallback");

const explicitCwd = "/explicit/child-workspace";
await tool.execute("explicit-cwd", {
  harness: AgentRunHarness.ClaudeCode,
  task: "use the explicit child workspace",
  cwd: explicitCwd,
}, undefined, undefined, context);
assert.equal(inputs[1]?.cwd, explicitCwd, "explicit child cwd is forwarded unchanged");

await tool.execute("relative-cwd", {
  harness: AgentRunHarness.ClaudeCode,
  task: "use a child directory within the selected workspace",
  cwd: "packages/core",
}, undefined, undefined, context);
assert.equal(inputs[2]?.cwd, resolve(activeToolCwd, "packages/core"),
  "a relative explicit cwd resolves from the active tool context, not the daemon process");
assert.equal(resolutions.length, 1, "explicit absolute and relative cwd never consult root selection");

await tool.execute("default-claude", {
  harness: AgentRunHarness.ClaudeCode,
  task: "research failures",
  cwd: process.cwd(),
}, undefined, undefined, context);
assert.equal(inputs[3]?.model, undefined, "the tool leaves unpinned model resolution to the launch boundary");

await tool.execute("default-codex", {
  harness: AgentRunHarness.Codex,
  task: "review changes",
  cwd: process.cwd(),
}, undefined, undefined, context);
assert.equal(inputs[4]?.model, undefined, "the tool does not inherit an ambient Codex harness default");

await tool.execute("pinned-codex", {
  harness: AgentRunHarness.Codex,
  task: "review changes",
  cwd: process.cwd(),
  model: "caller-selected-model",
}, undefined, undefined, context);
assert.equal(inputs[5]?.model, "caller-selected-model", "a caller-pinned model always wins");

await tool.execute("pinned-effort", {
  harness: AgentRunHarness.Codex,
  task: "review changes",
  cwd: process.cwd(),
  effort: "xhigh",
}, undefined, undefined, context);
assert.equal(inputs[6]?.effort, "xhigh", "the tool preserves a caller-pinned effort");

await tool.execute("frontier-effort", {
  harness: AgentRunHarness.Codex,
  task: "review changes",
  cwd: process.cwd(),
  effort: "ultra",
}, undefined, undefined, context);
assert.equal(inputs[7]?.effort, "ultra", "the tool preserves an advertised frontier effort exactly");

await tool.execute("null-effort", {
  harness: AgentRunHarness.Codex,
  task: "override approved effort",
  cwd: process.cwd(),
  effort: null,
}, undefined, undefined, context);
assert.ok(Object.hasOwn(inputs[8] ?? {}, "effort"), "explicit null remains distinguishable from omission");
assert.equal(inputs[8]?.effort, null, "the tool forwards explicit null effort");

const unselectedContext = {
  cwd: "/unselected/fallback",
  sessionManager: { getSessionId: () => "unselected-thread" },
} as Parameters<typeof tool.execute>[4];
await tool.execute("unselected-cwd", {
  harness: AgentRunHarness.Codex,
  task: "retain the active workspace",
}, undefined, undefined, unselectedContext);
assert.equal(inputs[9]?.cwd, unselectedContext.cwd, "no durable selection retains the active context fallback");

resolutionError = new Error("selected worktree is unavailable or has changed Git identity");
await assert.rejects(() => tool.execute("invalid-selection", {
  harness: AgentRunHarness.Codex,
  task: "fail before launch",
}, undefined, undefined, context), /selected worktree is unavailable or has changed Git identity/);
assert.equal(inputs.length, 10, "an unavailable or mismatched selection fails before delegation");

process.stdout.write("ok — delegate_agent schema and forwarding preserve cwd, model, and nullable effort pins\n");
