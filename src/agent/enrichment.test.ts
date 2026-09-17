import assert from "node:assert/strict";
import type { OwnerOperatorPiServices } from "./agent";
import { enrichThread, parseAssessment, parseDetails, STATUS_SUMMARY_MAX_CHARS } from "./enrichment";

const details = { topic: "Export implementation", statusSummary: "Export implemented; tests passed.", priority: 2, attention: "idle" };
const recorded = { topic: details.topic, statusSummary: details.statusSummary, priority: details.priority, ownerAction: null };
assert.deepEqual(parseDetails(recorded), details);
assert.deepEqual(parseDetails({ ...recorded, ownerAction: "Choose the retention policy.", statusSummary: "Choose the retention policy." }), {
  ...details, attention: "needs-you", statusSummary: "Choose the retention policy.",
});
assert.equal(parseAssessment({ ...recorded, ownerAction: "Choose the retention policy." }).ownerAction, "Choose the retention policy.");
for (const ownerAction of ["", "   ", ["review"], 1, false, undefined]) {
  assert.throws(() => parseDetails({ ...recorded, ownerAction }), /ownerAction/);
}
for (const field of ["topic", "statusSummary"]) {
  for (const invalid of [undefined, "", "   ", 3]) {
    assert.throws(() => parseDetails({ ...recorded, [field]: invalid }), new RegExp(field));
  }
}
for (const priority of [undefined, "3", 0, 6, 2.5]) {
  assert.throws(() => parseDetails({ ...recorded, priority }), /priority/);
}
for (const attention of ["needs-you", "working", "done"]) {
  assert.equal(parseDetails({ ...recorded, attention }).attention, "idle",
    "a model flag cannot create owner attention or lifecycle state without an owner action");
}
assert.equal(parseDetails({ ...recorded, statusSummary: "x".repeat(STATUS_SUMMARY_MAX_CHARS + 30) }).statusSummary.length, STATUS_SUMMARY_MAX_CHARS + 30,
  "a status summary over the target is shown as written; the limit is the prompt's, not a gate");

assert.deepEqual(
  parseDetails({ ...recorded, topic: null, statusSummary: null }, { title: "Export implementation", statusSummary: "Export under way." }),
  { ...details, statusSummary: "Export under way." },
  "null keeps the current title and status summary",
);
assert.throws(() => parseDetails({ ...recorded, statusSummary: null }), /does not exist/);

function fakeServices(completions: Array<Record<string, unknown>>, onCall?: (systemPrompt: string, tools: unknown) => void) {
  return {
    settingsManager: { getDefaultProvider: () => "test", getDefaultModel: () => "test-model" },
    modelRuntime: {
      getModel: () => ({ provider: "test", id: "test-model" }),
      getAuth: async () => ({}),
      completeSimple: async (_model: unknown, context: { systemPrompt: string; messages: Array<{ content: string }>; tools: unknown }) => {
        onCall?.(`${context.systemPrompt}\n${context.messages[0].content}`, context.tools);
        const completion = completions.shift();
        assert.ok(completion);
        return { stopReason: "stop", content: [{ type: "toolCall", id: "call", name: "record_assessment", arguments: completion }] };
      },
    },
  } as unknown as OwnerOperatorPiServices;
}

const prompts: string[] = [];
let tools: unknown;
const reconciled = await enrichThread("PR #14 remains open.", {
  services: fakeServices([
    { ...recorded, ownerAction: "Review PR #14.", statusSummary: "PR #14 awaits owner review." },
    { ...recorded, ownerAction: null, statusSummary: "PR #14 merged. No owner action remains." },
  ], (prompt, contextTools) => { prompts.push(prompt); tools = contextTools; }),
  resolveOwnerAction: async (ownerAction) => {
    assert.equal(ownerAction, "Review PR #14.");
    return "A later session reports PR #14 merged.";
  },
});
assert.equal(prompts.length, 2, "a possible owner action receives one cross-session reconciliation pass");
assert.match(prompts[1], /A later session reports PR #14 merged/);
assert.equal(reconciled.attention, "idle");
assert.equal(reconciled.statusSummary, "PR #14 merged. No owner action remains.");
const [tool] = tools as Array<{ name: string; parameters: { properties: { statusSummary: { anyOf: Array<{ maxLength?: number }> } } }; constrainedSampling: unknown }>;
assert.equal(tool.name, "record_assessment");
assert.ok((tool.parameters.properties.statusSummary.anyOf[0].maxLength ?? 0) > STATUS_SUMMARY_MAX_CHARS, "the schema bound sits above the contract so a provider cut fails validation instead of displaying");
assert.deepEqual(tool.constrainedSampling, { type: "json_schema", strict: "require" });
assert.match(prompts[0], /Artifact storage confirmed at `workspace\/artifacts\/`/, "the alignment examples ground the prompt");

let historyPrompt = "";
const kept = await enrichThread("More tool calls.", {
  services: fakeServices([{ topic: null, statusSummary: null, priority: 3, ownerAction: null }], (prompt) => { historyPrompt = prompt; }),
  currentTitle: "Export implementation",
  statusSummaries: [
    { version: 3, createdAt: "2026-06-09T12:00:00.000Z", statusSummary: "Export under way.", bookmarkIndex: 41 },
    { version: 2, createdAt: "2026-06-09T11:00:00.000Z", statusSummary: "Export design chosen.", bookmarkIndex: 12 },
  ],
});
assert.deepEqual(kept, { topic: "Export implementation", statusSummary: "Export under way.", priority: 3, attention: "idle" });
assert.match(historyPrompt, /v3 2026-06-09T12:00:00.000Z, written at message 41: Export under way\.\n- v2 .*: Export design chosen\./, "the model reads the recorded revisions, newest first, with their positions");

console.log("ok - schema-bounded status summaries, kept text, history-grounded prompt, cross-session owner-action reconciliation");
