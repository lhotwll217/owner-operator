import assert from "node:assert";
import { AgentRunHarness } from "@owner-operator/core";
import type {
  HarnessDetailsSnapshot,
  ReadHarnessDetailsOptions,
} from "../../agent-runs/harness-details";
import { createGetHarnessDetailsTool } from "./get-harness-details";

const OBSERVED_AT = "2026-08-25T00:00:00.000Z";
const snapshot: HarnessDetailsSnapshot = {
  observedAt: OBSERVED_AT,
  ephemeral: true,
  preferences: {
    path: "/fixture/user-harness-preferences.md",
    content: "owner preference\n",
    error: null,
  },
  capabilities: {
    registry: { acpxVersion: "0.13.1", registeredAgentNames: ["codex"] },
    harnesses: [],
  },
  account: [],
  unknowns: [],
};

const calls: ReadHarnessDetailsOptions[] = [];
const tool = createGetHarnessDetailsTool({
  read: async (input) => {
    calls.push(input);
    return snapshot;
  },
});

assert.equal(tool.name, "get_harness_details");
assert.match(tool.description, /never-cached/i, "the snapshot lifetime is explicit");
assert.match(tool.description, /complete configOptions/, "capability completeness is explicit");
assert.match(tool.description, /runtime provenance/, "provenance is explicit without duplicating its schema");
assert.match(tool.description, /null means unknown/i, "the unknown-versus-none contract is explicit");
assert.match(tool.description, /subscription limits/i, "allowance percentages name their denominator");
assert.match(tool.description, /does not choose or save/i, "observation stays separate from selection");
const inspectParameter = tool.parameters.properties.inspect;
assert.match(inspectParameter.description ?? "", /one exact model and nullable effort per harness/i);
assert.match(inspectParameter.description ?? "", /opaque/i);
const baselineParameter = tool.parameters.properties.includeBaselineCandidates;
assert.match(
  baselineParameter.description ?? "",
  /Starts no additional session/,
  "baseline projection cost text matches the ordinary snapshot's already-opened ACP session",
);

const context = {
  sessionManager: { getSessionId: () => "parent-thread" },
} as Parameters<typeof tool.execute>[4];

const all = await tool.execute("call-1", {}, undefined, undefined, context);
assert.deepEqual(calls[0], {}, "an unfiltered read requests every harness and no candidate projection");
assert.equal(all.details, snapshot, "the thin adapter returns the facade snapshot unchanged");
const body = all.content[0];
assert.ok(body?.type === "text", "the tool answers with a text body");
assert.deepEqual(JSON.parse(body.text), snapshot, "the text body mirrors the structured result");

await tool.execute("call-2", {
  harnesses: [AgentRunHarness.Codex],
  inspect: [{
    harness: AgentRunHarness.Codex,
    model: "gpt-5.6-sol[opaque]",
    effort: null,
  }],
  includeBaselineCandidates: true,
}, undefined, undefined, context);
assert.deepEqual(calls[1], {
  harnesses: [AgentRunHarness.Codex],
  inspect: [{
    harness: AgentRunHarness.Codex,
    model: "gpt-5.6-sol[opaque]",
    effort: null,
  }],
  includeBaselineCandidates: true,
}, "the harness filter and baseline projection request reach the snapshot facade unchanged");

process.stdout.write("ok — get_harness_details returns the namespaced ACP snapshot unchanged\n");
