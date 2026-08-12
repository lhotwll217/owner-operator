import assert from "node:assert";
import { AgentRunHarness } from "@owner-operator/core";
import {
  CODEX_ACCOUNT_READ,
  CODEX_MODEL_LIST,
  CODEX_RATE_LIMITS_READ,
} from "../../test/fixtures/codex-app-server";
import {
  CODEX_DETAILS_SOURCE,
  normalizeCodexHarnessDetails,
  readHarnessDetails,
  type CodexAppServerPayloads,
  type HarnessBaselineCandidate,
} from "./harness-details";

const OBSERVED_AT = "2026-08-12T00:00:00.000Z";
const capturedPayloads: CodexAppServerPayloads = {
  account: CODEX_ACCOUNT_READ,
  rateLimits: CODEX_RATE_LIMITS_READ,
  models: CODEX_MODEL_LIST,
};

// --- Codex normalization over the captured first-party payloads -------------------------------

const codex = normalizeCodexHarnessDetails(capturedPayloads, OBSERVED_AT);

assert.equal(codex.harness, AgentRunHarness.Codex);
assert.equal(codex.observedAt, OBSERVED_AT, "the snapshot carries its own observation time");
assert.equal(codex.source, CODEX_DETAILS_SOURCE, "facts name the protocol that produced them");
assert.deepEqual(codex.account, { plan: "prolite" }, "the subscription plan is read, not inferred");

assert.deepEqual(
  codex.models?.map(({ id }) => id),
  ["gpt-5.6-sol", "gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark"],
  "the catalog is reported in the order the harness advertised it, unranked",
);
assert.deepEqual(codex.models?.[0], {
  id: "gpt-5.6-sol",
  displayName: "GPT-5.6-Sol",
  reasoningLevels: ["low", "medium", "high", "xhigh", "max", "ultra"],
  defaultReasoningLevel: "low",
  isDefault: true,
});
assert.deepEqual(
  codex.models?.filter(({ isDefault }) => isDefault).map(({ id }) => id),
  ["gpt-5.6-sol"],
  "exactly the harness-advertised default is flagged",
);
assert.deepEqual(
  codex.models?.find(({ id }) => id === "gpt-5.5")?.reasoningLevels,
  ["low", "medium", "high", "xhigh"],
  "reasoning levels are per model, not a single global list",
);

assert.deepEqual(codex.allowanceWindows, [
  { id: "codex:primary", label: null, usedPercent: 9, resetsAt: 1787129876, windowMinutes: 10080 },
  {
    id: "codex_bengalfox:primary",
    label: "GPT-5.3-Codex-Spark",
    usedPercent: 0,
    resetsAt: 1787150352,
    windowMinutes: 10080,
  },
], "every advertised limit becomes its own window row, keyed by limit id and slot");

assert.equal(codex.baselineCandidate, null, "reading facts alone proposes no baseline");
assert.deepEqual(codex.errors, []);
assert.ok(
  !Object.keys(codex).some((key) => /recommend|rank|best|score/i.test(key)),
  "the details layer exposes no selection or ranking field",
);

// --- null means unknown; [] means observed-and-none -------------------------------------------

const observedNone = normalizeCodexHarnessDetails({
  account: { account: {} },
  rateLimits: { rateLimits: { limitId: "codex", primary: null, secondary: null } },
  models: { data: [] },
}, OBSERVED_AT);
assert.deepEqual(observedNone.models, [], "an empty advertised catalog is empty, not unknown");
assert.deepEqual(observedNone.allowanceWindows, [], "a limit with no windows is empty, not unknown");
assert.deepEqual(observedNone.account, { plan: null }, "an account without a plan reports plan unknown");

const unknownFacts = normalizeCodexHarnessDetails({
  account: null,
  rateLimits: null,
  models: null,
}, OBSERVED_AT);
assert.equal(unknownFacts.models, null, "an unreadable catalog is unknown, not empty");
assert.equal(unknownFacts.allowanceWindows, null, "unreadable allowances are unknown, not empty");
assert.equal(unknownFacts.account, null);

const partial = normalizeCodexHarnessDetails({
  account: CODEX_ACCOUNT_READ,
  rateLimits: null,
  models: CODEX_MODEL_LIST,
}, OBSERVED_AT);
assert.equal(partial.allowanceWindows, null);
assert.equal(partial.models?.length, 5, "one unreadable fact does not erase the others");
assert.deepEqual(partial.account, { plan: "prolite" });

// --- Both harnesses, observed independently ---------------------------------------------------

const both = await readHarnessDetails({
  deps: {
    now: () => new Date(OBSERVED_AT),
    readCodexPayloads: async () => capturedPayloads,
  },
});
assert.deepEqual(
  both.map(({ harness }) => harness),
  [AgentRunHarness.Codex, AgentRunHarness.ClaudeCode],
  "harnesses are returned in a fixed order, never ordered by usage or preference",
);
assert.ok(both.every(({ observedAt }) => observedAt === OBSERVED_AT), "one snapshot, one observation time");

const claude = both.find(({ harness }) => harness === AgentRunHarness.ClaudeCode);
assert.equal(claude?.models, null, "Claude Code exposes no catalog, so it stays unknown");
assert.equal(claude?.allowanceWindows, null, "Claude Code exposes no allowance surface, so it stays unknown");
assert.equal(claude?.account, null);
assert.equal(claude?.source, null, "no first-party surface means no source to name");
assert.match(claude?.notes.join(" ") ?? "", /unknown, not empty/i, "the unknown is stated, not implied");
assert.deepEqual(claude?.errors, [], "an absent surface is not an error");

// --- One harness failure cannot erase another -------------------------------------------------

const withFailure = await readHarnessDetails({
  deps: {
    now: () => new Date(OBSERVED_AT),
    readCodexPayloads: async () => { throw new Error("codex app-server unavailable"); },
  },
});
const failedCodex = withFailure.find(({ harness }) => harness === AgentRunHarness.Codex);
assert.deepEqual(failedCodex?.errors, ["codex app-server unavailable"], "the failure is reported, not swallowed");
assert.equal(failedCodex?.models, null, "a failed read leaves facts unknown rather than empty");
assert.equal(
  withFailure.find(({ harness }) => harness === AgentRunHarness.ClaudeCode)?.notes.length,
  1,
  "the other harness is observed regardless",
);

// --- Baseline candidates are reported, never saved --------------------------------------------

const candidate: HarnessBaselineCandidate = {
  model: "gpt-5.6-sol",
  effort: "low",
  availableEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
};
const probed = await readHarnessDetails({
  harnesses: [AgentRunHarness.Codex],
  includeBaselineCandidates: true,
  deps: {
    now: () => new Date(OBSERVED_AT),
    readCodexPayloads: async () => capturedPayloads,
    discoverBaselineCandidate: async () => candidate,
  },
});
assert.deepEqual(probed[0]?.baselineCandidate, candidate, "an unpinned session reports what the harness chose");

const notProbed = await readHarnessDetails({
  harnesses: [AgentRunHarness.Codex],
  deps: {
    now: () => new Date(OBSERVED_AT),
    readCodexPayloads: async () => capturedPayloads,
    discoverBaselineCandidate: async () => { throw new Error("discovery must not run unrequested"); },
  },
});
assert.equal(notProbed[0]?.baselineCandidate, null, "candidate discovery is opt-in, never implicit");

const probeFailed = await readHarnessDetails({
  harnesses: [AgentRunHarness.Codex],
  includeBaselineCandidates: true,
  deps: {
    now: () => new Date(OBSERVED_AT),
    readCodexPayloads: async () => capturedPayloads,
    discoverBaselineCandidate: async () => { throw new Error("session init failed"); },
  },
});
assert.equal(probeFailed[0]?.models?.length, 5, "a failed candidate probe keeps the facts already read");
assert.deepEqual(probeFailed[0]?.baselineCandidate, null);
assert.deepEqual(probeFailed[0]?.errors, ["baseline candidate: session init failed"]);

process.stdout.write("ok — harness details normalize captured Codex payloads and keep unknowns honest\n");
