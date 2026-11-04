import assert from "node:assert/strict";
import type { OwnerOperatorPiServices } from "./agent";
import { enrichThread, parseAccount, STATUS_SUMMARY_MAX_CHARS } from "./enrichment";

const account = { topic: "Export implementation", statusSummary: "Export implemented; tests passed." };
assert.deepEqual(parseAccount(account), account);
assert.deepEqual(parseAccount({ ...account, ownerAction: "Choose the retention policy.", priority: 5 }), account,
  "the account carries no owner attention; Need You is decided by its own call");
for (const field of ["topic", "statusSummary"]) {
  for (const invalid of [undefined, "", "   ", 3]) {
    assert.throws(() => parseAccount({ ...account, [field]: invalid }), new RegExp(field));
  }
}
assert.equal(parseAccount({ ...account, statusSummary: "x".repeat(STATUS_SUMMARY_MAX_CHARS + 30) }).statusSummary.length, STATUS_SUMMARY_MAX_CHARS + 30,
  "a status summary over the target is shown as written; the limit is the prompt's, not a gate");

assert.deepEqual(
  parseAccount({ topic: null, statusSummary: null }, { title: "Export implementation", statusSummary: "Export under way." }),
  { ...account, statusSummary: "Export under way." },
  "null keeps the current title and status summary",
);
assert.throws(() => parseAccount({ ...account, statusSummary: null }), /does not exist/);

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
const written = await enrichThread("PR #14 remains open.", {
  services: fakeServices([{ ...account, statusSummary: "PR #14 awaits review." }], (prompt, contextTools) => { prompts.push(prompt); tools = contextTools; }),
});
assert.equal(prompts.length, 1, "one call writes the title and status summary");
assert.deepEqual(written, { ...account, statusSummary: "PR #14 awaits review." });
assert.doesNotMatch(prompts[0], /ownerAction|priority/, "the account prompt asks for no owner attention");
const [tool] = tools as Array<{ name: string; parameters: { properties: Record<string, { anyOf: Array<{ maxLength?: number }> }> }; constrainedSampling: unknown }>;
assert.equal(tool.name, "record_assessment");
assert.deepEqual(Object.keys(tool.parameters.properties), ["topic", "statusSummary"]);
assert.ok((tool.parameters.properties.statusSummary.anyOf[0].maxLength ?? 0) > STATUS_SUMMARY_MAX_CHARS, "the schema bound sits above the contract so a provider cut fails validation instead of displaying");
assert.deepEqual(tool.constrainedSampling, { type: "json_schema", strict: "require" });
assert.match(prompts[0], /Artifact storage confirmed at `workspace\/artifacts\/`/, "the alignment examples ground the prompt");

let historyPrompt = "";
const kept = await enrichThread("More tool calls.", {
  services: fakeServices([{ topic: null, statusSummary: null }], (prompt) => { historyPrompt = prompt; }),
  currentTitle: "Export implementation",
  statusSummaries: [
    { version: 3, createdAt: "2026-06-09T12:00:00.000Z", statusSummary: "Export under way.", bookmarkIndex: 41 },
    { version: 2, createdAt: "2026-06-09T11:00:00.000Z", statusSummary: "Export design chosen.", bookmarkIndex: 12 },
  ],
});
assert.deepEqual(kept, { topic: "Export implementation", statusSummary: "Export under way." });
assert.match(historyPrompt, /v3 2026-06-09T12:00:00.000Z, written at message 41: Export under way\.\n- v2 .*: Export design chosen\./, "the model reads the recorded revisions, newest first, with their positions");

console.log("ok - title and status summary only, schema-bounded, kept text, history-grounded prompt");
