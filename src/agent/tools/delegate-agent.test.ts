import assert from "node:assert";
import {
  AgentRunHarness,
  AgentRunStatus,
  type AgentRunCreateInput,
  type GatewayApi,
} from "@owner-operator/core";
import { agentRunFixture as run } from "../../../test/fixtures/agent-run";
import { createDelegateAgentTool } from "./delegate-agent";

const inputs: AgentRunCreateInput[] = [];
const backend = {
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
} as Pick<GatewayApi, "delegateAgent" | "waitAgentRun">;
const tool = createDelegateAgentTool({ resolveGateway: async () => backend });
assert.match(tool.description, /do not poll/i, "the tool tells the Operator that completion is delivered automatically");
const context = {
  sessionManager: { getSessionId: () => "parent-thread" },
} as Parameters<typeof tool.execute>[4];

await tool.execute("default-claude", {
  harness: AgentRunHarness.ClaudeCode,
  task: "research failures",
  cwd: process.cwd(),
}, undefined, undefined, context);
assert.equal(inputs[0]?.model, undefined, "the tool leaves unpinned model resolution to the launch boundary");

await tool.execute("default-codex", {
  harness: AgentRunHarness.Codex,
  task: "review changes",
  cwd: process.cwd(),
}, undefined, undefined, context);
assert.equal(inputs[1]?.model, undefined, "the tool does not inherit an ambient Codex harness default");

await tool.execute("pinned-codex", {
  harness: AgentRunHarness.Codex,
  task: "review changes",
  cwd: process.cwd(),
  model: "caller-selected-model",
}, undefined, undefined, context);
assert.equal(inputs[2]?.model, "caller-selected-model", "a caller-pinned model always wins");

await tool.execute("pinned-effort", {
  harness: AgentRunHarness.Codex,
  task: "review changes",
  cwd: process.cwd(),
  effort: "xhigh",
}, undefined, undefined, context);
assert.equal(inputs[3]?.effort, "xhigh", "the tool preserves a caller-pinned effort");

process.stdout.write("ok — delegate_agent defers defaults while preserving model and effort pins\n");
