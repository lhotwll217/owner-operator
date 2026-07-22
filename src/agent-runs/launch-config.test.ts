import assert from "node:assert";
import { AgentRunHarness } from "@owner-operator/core";
import { AGENT_RUN_LAUNCH_CONFIG, resolveAgentRunEffort, resolveAgentRunModel } from "./launch-config";

assert.equal(AGENT_RUN_LAUNCH_CONFIG[AgentRunHarness.ClaudeCode].defaultModel, "sonnet");
assert.equal(AGENT_RUN_LAUNCH_CONFIG[AgentRunHarness.Codex].defaultModel, "gpt-5.6-sol");
assert.equal(AGENT_RUN_LAUNCH_CONFIG[AgentRunHarness.ClaudeCode].defaultEffort, undefined);
assert.equal(AGENT_RUN_LAUNCH_CONFIG[AgentRunHarness.Codex].defaultEffort, "high");
assert.equal(resolveAgentRunModel(AgentRunHarness.ClaudeCode), "sonnet");
assert.equal(resolveAgentRunModel(AgentRunHarness.Codex), "gpt-5.6-sol");
assert.equal(
  resolveAgentRunModel(AgentRunHarness.Codex, "caller-selected-model"),
  "caller-selected-model",
  "a caller-pinned model always wins",
);
assert.equal(resolveAgentRunEffort(AgentRunHarness.ClaudeCode), null, "unsupported harnesses record no filler default");
assert.equal(resolveAgentRunEffort(AgentRunHarness.Codex), "high", "Codex uses its launch-config default");
assert.equal(
  resolveAgentRunEffort(AgentRunHarness.Codex, "minimal"),
  "minimal",
  "a caller-pinned effort always wins",
);

process.stdout.write("ok — delegated runs resolve configured model and effort defaults\n");
