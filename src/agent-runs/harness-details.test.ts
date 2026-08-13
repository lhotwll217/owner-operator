import assert from "node:assert";
import { AgentRunHarness } from "@owner-operator/core";
import {
  CODEX_ACCOUNT_READ,
  CODEX_MODEL_LIST,
  CODEX_RATE_LIMITS_READ,
} from "../../test/fixtures/codex-app-server";
import { CURSOR_ABOUT, CURSOR_ACP_MODELS, CURSOR_STATUS } from "../../test/fixtures/cursor-cli";
import {
  CODEX_DETAILS_SOURCE,
  CURSOR_DETAILS_SOURCE,
  normalizeCodexHarnessDetails,
  normalizeCursorHarnessDetails,
  readHarnessDetails,
  type CodexAppServerPayloads,
  type CursorCliPayloads,
  type HarnessBaselineCandidate,
} from "./harness-details";

const OBSERVED_AT = "2026-08-12T00:00:00.000Z";
const capturedPayloads: CodexAppServerPayloads = {
  account: CODEX_ACCOUNT_READ,
  rateLimits: CODEX_RATE_LIMITS_READ,
  models: CODEX_MODEL_LIST,
};
const capturedCursorPayloads: CursorCliPayloads = {
  about: CURSOR_ABOUT,
  status: CURSOR_STATUS,
  acpModels: CURSOR_ACP_MODELS,
  errors: [],
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
  unsupportedReasoningLevels: [],
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

// Reasoning levels follow the same rule per model: only an advertised empty list is "none".
const reasoning = normalizeCodexHarnessDetails({
  account: null,
  rateLimits: null,
  models: {
    data: [
      { id: "advertised-none", supportedReasoningEfforts: [] },
      { id: "absent-field" },
      { id: "not-a-list", supportedReasoningEfforts: "high" },
      { id: "unreadable-entries", supportedReasoningEfforts: [{ description: "no level here" }] },
      {
        id: "partly-readable",
        supportedReasoningEfforts: [{ reasoningEffort: "high" }, { description: "no level here" }],
      },
      { id: "unsupported", supportedReasoningEfforts: [{ reasoningEffort: "turbo" }] },
    ],
  },
}, OBSERVED_AT);
const levelsOf = (id: string): string[] | null | undefined =>
  reasoning.models?.find((model) => model.id === id)?.reasoningLevels;

assert.deepEqual(levelsOf("advertised-none"), [], "an advertised empty list is observed-none");
assert.equal(levelsOf("absent-field"), null, "a model that advertises no levels is unknown, not none");
assert.equal(levelsOf("not-a-list"), null, "a malformed levels field is unknown, not none");
assert.equal(
  levelsOf("unreadable-entries"),
  null,
  "entries carrying no readable level leave the list unknown rather than claiming none",
);
assert.deepEqual(levelsOf("partly-readable"), ["high"], "readable levels survive an unreadable sibling");
assert.deepEqual(levelsOf("unsupported"), [], "an effort the adapter cannot apply is not advertised as selectable");
assert.deepEqual(
  reasoning.models?.find((model) => model.id === "unsupported")?.unsupportedReasoningLevels,
  ["turbo"],
  "an advertised but inapplicable effort is represented honestly as unsupported",
);

const partial = normalizeCodexHarnessDetails({
  account: CODEX_ACCOUNT_READ,
  rateLimits: null,
  models: CODEX_MODEL_LIST,
}, OBSERVED_AT);
assert.equal(partial.allowanceWindows, null);
assert.equal(partial.models?.length, 5, "one unreadable fact does not erase the others");
assert.deepEqual(partial.account, { plan: "prolite" });

// --- Cursor normalization over the captured first-party CLI payloads --------------------------

const cursor = normalizeCursorHarnessDetails(capturedCursorPayloads, OBSERVED_AT);
assert.equal(cursor.harness, AgentRunHarness.Cursor);
assert.equal(cursor.source, CURSOR_DETAILS_SOURCE, "facts name the CLI surface that produced them");
assert.deepEqual(cursor.account, { plan: "Pro" }, "the subscription tier is read, not inferred");
assert.equal(cursor.models?.length, 8, "every ACP-advertised entry becomes a model row");
assert.deepEqual(cursor.models?.[0], {
  id: "default[]",
  displayName: "Auto",
  reasoningLevels: null,
  unsupportedReasoningLevels: [],
  defaultReasoningLevel: null,
  isDefault: false,
}, "ids are the ACP launch vocabulary verbatim; effort-in-id models advertise no levels");
assert.deepEqual(
  cursor.models?.filter(({ isDefault }) => isDefault).map(({ id }) => id),
  ["claude-fable-5[thinking=true,context=300k,effort=high]"],
  "exactly the entry an unpinned session selected is flagged as default",
);
assert.equal(cursor.allowanceWindows, null, "Cursor exposes no allowance surface, so it stays unknown");
assert.match(cursor.notes.join(" "), /unknown, not empty/i);
assert.match(cursor.notes.join(" "), /ACP-advertised/, "the catalog names its launch-authoritative source");
assert.deepEqual(cursor.errors, [], "an authenticated CLI observation carries no errors");

const cursorUnknown = normalizeCursorHarnessDetails(
  { about: null, status: null, acpModels: null, errors: ["cursor-agent acp: spawn failed"] },
  OBSERVED_AT,
);
assert.equal(cursorUnknown.models, null, "an unreadable catalog is unknown, not empty");
assert.equal(cursorUnknown.account, null);
assert.deepEqual(cursorUnknown.errors, ["cursor-agent acp: spawn failed"], "client errors surface verbatim");

// A session response with no readable catalog is a shape mismatch, not an observed-empty catalog.
const cursorUnrecognized = normalizeCursorHarnessDetails({
  about: CURSOR_ABOUT,
  status: CURSOR_STATUS,
  acpModels: { unexpected: "shape" },
  errors: [],
}, OBSERVED_AT);
assert.equal(cursorUnrecognized.models, null, "an unrecognized session response is unknown, never observed-none");
assert.deepEqual(cursorUnrecognized.errors, ["cursor-agent acp: no model catalog recognized in session response"]);

// Only an advertised empty list means the account can select nothing.
const cursorEmpty = normalizeCursorHarnessDetails({
  about: CURSOR_ABOUT,
  status: CURSOR_STATUS,
  acpModels: { currentModelId: null, availableModels: [] },
  errors: [],
}, OBSERVED_AT);
assert.deepEqual(cursorEmpty.models, [], "an advertised empty catalog is empty, not unknown");
assert.deepEqual(cursorEmpty.errors, []);

const cursorUnauthenticated = normalizeCursorHarnessDetails({
  about: CURSOR_ABOUT,
  status: { status: "not_authenticated", isAuthenticated: false },
  acpModels: CURSOR_ACP_MODELS,
  errors: [],
}, OBSERVED_AT);
assert.match(cursorUnauthenticated.errors.join(" "), /not authenticated/, "signed-out auth is an explicit error");
assert.equal(cursorUnauthenticated.models?.length, 8, "auth state does not erase facts already read");

// --- All harnesses, observed independently ----------------------------------------------------

const both = await readHarnessDetails({
  deps: {
    now: () => new Date(OBSERVED_AT),
    readCodexPayloads: async () => capturedPayloads,
    readCursorPayloads: async () => capturedCursorPayloads,
  },
});
assert.deepEqual(
  both.map(({ harness }) => harness),
  [AgentRunHarness.Codex, AgentRunHarness.ClaudeCode, AgentRunHarness.Cursor],
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
    readCursorPayloads: async () => capturedCursorPayloads,
  },
});
const failedCodex = withFailure.find(({ harness }) => harness === AgentRunHarness.Codex);
assert.deepEqual(failedCodex?.errors, ["codex app-server unavailable"], "the failure is reported, not swallowed");
assert.equal(failedCodex?.models, null, "a failed read leaves facts unknown rather than empty");
assert.equal(
  withFailure.find(({ harness }) => harness === AgentRunHarness.ClaudeCode)?.notes.length,
  1,
  "the other harnesses are observed regardless",
);
assert.equal(
  withFailure.find(({ harness }) => harness === AgentRunHarness.Cursor)?.models?.length,
  8,
  "a Codex failure cannot erase Cursor's facts",
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

process.stdout.write("ok — harness details normalize captured Codex and Cursor payloads and keep unknowns honest\n");
