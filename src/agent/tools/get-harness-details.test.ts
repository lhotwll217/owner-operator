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
    path: "/fixture/harness-roster.md",
    source: "legacy-harness-roster",
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
assert.match(tool.description, /never-cached/i, "the tool states its snapshot is ephemeral");
assert.match(tool.description, /complete configOptions/, "the tool promises complete ACP configuration objects");
assert.match(tool.description, /adapter, backend/, "the tool names exact runtime provenance");
assert.match(tool.description, /separate preferences, ACP capabilities/, "namespace ownership is explicit");
assert.match(tool.description, /null means unknown/i, "the tool states the unknown-versus-none contract");
assert.match(tool.description, /same apply-and-confirm behavior as delegated launch/i);
assert.match(tool.description, /matching confirmation/i);
assert.match(tool.description, /does not choose/i, "the tool states it performs no selection");
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

await assert.rejects(
  tool.execute("call-3", {
    inspect: [
      { harness: AgentRunHarness.Codex, model: "first", effort: "low" },
      { harness: AgentRunHarness.Codex, model: "second", effort: null },
    ],
  }, undefined, undefined, context),
  /duplicate inspection.*codex/i,
  "the public tool rejects two inspection entries for one harness before reading",
);
assert.equal(calls.length, 2);

process.stdout.write("ok — get_harness_details returns the namespaced ACP snapshot unchanged\n");
