import assert from "node:assert";
import { AgentRunHarness } from "@owner-operator/core";
import type { HarnessDetails, ReadHarnessDetailsOptions } from "../../agent-runs/harness-details";
import { createGetHarnessDetailsTool } from "./get-harness-details";

const OBSERVED_AT = "2026-08-12T00:00:00.000Z";
const detailsFor = (harness: AgentRunHarness): HarnessDetails => ({
  harness,
  observedAt: OBSERVED_AT,
  source: null,
  account: null,
  models: null,
  allowanceWindows: null,
  baselineCandidate: null,
  notes: [],
  errors: [],
});

const calls: ReadHarnessDetailsOptions[] = [];
const tool = createGetHarnessDetailsTool({
  read: async (input) => {
    calls.push(input);
    return [detailsFor(AgentRunHarness.Codex), detailsFor(AgentRunHarness.ClaudeCode)];
  },
});

assert.equal(tool.name, "get_harness_details");
assert.match(tool.description, /never cached/i, "the tool states its snapshot is ephemeral");
assert.match(tool.description, /null means/i, "the tool states the unknown-versus-none contract");
assert.match(tool.description, /does not choose/i, "the tool states it performs no selection");

const context = {
  sessionManager: { getSessionId: () => "parent-thread" },
} as Parameters<typeof tool.execute>[4];

const all = await tool.execute("call-1", {}, undefined, undefined, context);
assert.deepEqual(calls[0], {}, "an unfiltered read requests every harness and no probe");
assert.equal(all.details.ephemeral, true);
assert.equal(all.details.observedAt, OBSERVED_AT);
assert.deepEqual(
  all.details.details.map(({ harness }) => harness),
  [AgentRunHarness.Codex, AgentRunHarness.ClaudeCode],
  "the adapter passes rows through in order and does not rank them",
);
const body = all.content[0];
assert.ok(body?.type === "text", "the tool answers with a text body");
assert.deepEqual(JSON.parse(body.text), all.details, "the text body mirrors the structured result");

await tool.execute("call-2", {
  harnesses: [AgentRunHarness.Codex],
  includeBaselineCandidates: true,
}, undefined, undefined, context);
assert.deepEqual(calls[1], {
  harnesses: [AgentRunHarness.Codex],
  includeBaselineCandidates: true,
}, "an explicit harness filter and opt-in probe reach the details layer unchanged");

process.stdout.write("ok — get_harness_details reports observations without selecting among them\n");
