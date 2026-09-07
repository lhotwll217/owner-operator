import assert from "node:assert";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { AgentRunHarness } from "@owner-operator/core";
import {
  CODEX_ACCOUNT_READ,
  CODEX_RATE_LIMITS_READ,
} from "../../test/fixtures/codex-app-server";
import { CURSOR_ABOUT, CURSOR_STATUS } from "../../test/fixtures/cursor-cli";
import {
  CODEX_ACCOUNT_SOURCE,
  CURSOR_ACCOUNT_SOURCE,
  normalizeCodexAccountObservation,
  normalizeCursorAccountObservation,
  readHarnessDetails,
  type HarnessCapabilityObservation,
} from "./harness-details";

const OBSERVED_AT = "2026-08-25T00:00:00.000Z";
const option = {
  type: "select",
  id: "model",
  name: "Model",
  category: "model",
  currentValue: "launch-model",
  options: [{ value: "launch-model", name: "Launch model", description: "complete choice" }],
  extensionField: { mustSurvive: true },
} as unknown as SessionConfigOption;

function capability(harness: AgentRunHarness): HarnessCapabilityObservation {
  const acpxAgent = harness === AgentRunHarness.ClaudeCode ? "claude" : harness;
  return {
    harness,
    acpxAgent,
    observedAt: OBSERVED_AT,
    runtime: {
      acpxVersion: "0.13.1",
      adapter: harness === AgentRunHarness.Cursor
        ? { packageName: null, packageVersion: null, resolution: "path" }
        : {
            packageName: `@agentclientprotocol/${acpxAgent}-acp`,
            packageVersion: "fixture-adapter",
            resolution: "package-lock",
          },
      backend: harness === AgentRunHarness.Cursor
        ? { name: "cursor-agent", version: "fixture-cursor", source: "path-command" }
        : { name: `fixture-${acpxAgent}-backend`, version: "fixture-backend", source: "adapter-dependency" },
    },
    requestedInspection: null,
    session: {
      models: { currentModelId: "launch-model", availableModelIds: ["launch-model"] },
      configOptions: [option],
      usage: null,
    },
    confirmation: null,
    error: null,
  };
}

const codexAccount = normalizeCodexAccountObservation({
  account: CODEX_ACCOUNT_READ,
  rateLimits: CODEX_RATE_LIMITS_READ,
}, OBSERVED_AT);
assert.equal(codexAccount.source, CODEX_ACCOUNT_SOURCE);
assert.deepEqual(codexAccount.account, { plan: "prolite" });
assert.deepEqual(codexAccount.allowanceWindows, [
  { id: "codex:primary", label: null, usedPercent: 9, resetsAt: 1787129876, windowMinutes: 10080 },
  {
    id: "codex_bengalfox:primary",
    label: "GPT-5.3-Codex-Spark",
    usedPercent: 0,
    resetsAt: 1787150352,
    windowMinutes: 10080,
  },
]);

const observedNone = normalizeCodexAccountObservation({
  account: { account: {} },
  rateLimits: { rateLimits: { limitId: "codex", primary: null, secondary: null } },
}, OBSERVED_AT);
assert.deepEqual(observedNone.account, { plan: null }, "an observed account with no plan keeps the plan unknown");
assert.deepEqual(observedNone.allowanceWindows, [], "advertised no allowance windows is observed-none");

const unknownAccount = normalizeCodexAccountObservation({ account: null, rateLimits: null }, OBSERVED_AT);
assert.equal(unknownAccount.account, null);
assert.equal(unknownAccount.allowanceWindows, null, "unreadable allowance state is unknown, not empty");

const cursorAccount = normalizeCursorAccountObservation({
  about: CURSOR_ABOUT,
  status: CURSOR_STATUS,
  errors: [],
}, OBSERVED_AT);
assert.equal(cursorAccount.source, CURSOR_ACCOUNT_SOURCE);
assert.deepEqual(cursorAccount.account, { plan: "Pro" });
assert.equal(cursorAccount.authenticated, true);
assert.equal(cursorAccount.allowanceWindows, null);

const snapshot = await readHarnessDetails({
  deps: {
    now: () => new Date(OBSERVED_AT),
    readRegistryProvenance: () => ({
      acpxVersion: "0.13.1",
      registeredAgentNames: ["claude", "codex", "cursor"],
    }),
    readPreferences: () => ({
      path: "/fixture/workspace/user-harness-preferences.md",
      content: "# Owner preferences\n",
      error: null,
    }),
    observeCapability: async (harness) => capability(harness),
    readCodexPayloads: async () => ({ account: CODEX_ACCOUNT_READ, rateLimits: CODEX_RATE_LIMITS_READ }),
    readCursorPayloads: async () => ({ about: CURSOR_ABOUT, status: CURSOR_STATUS, errors: [] }),
  },
});
assert.equal(snapshot.observedAt, OBSERVED_AT);
assert.equal(snapshot.ephemeral, true);
assert.equal(snapshot.preferences.content, "# Owner preferences\n");
assert.deepEqual(
  snapshot.capabilities.harnesses.map(({ harness }) => harness),
  [AgentRunHarness.Codex, AgentRunHarness.ClaudeCode, AgentRunHarness.Cursor, AgentRunHarness.OpenCode, AgentRunHarness.OpenCode2],
  "capabilities are fixed-order and unranked",
);
assert.equal(
  snapshot.capabilities.harnesses[0]?.session?.configOptions?.[0],
  option,
  "complete config options remain in the capability namespace without normalization",
);
assert.deepEqual(
  snapshot.account.map(({ harness }) => harness),
  [AgentRunHarness.Codex, AgentRunHarness.ClaudeCode, AgentRunHarness.Cursor, AgentRunHarness.OpenCode, AgentRunHarness.OpenCode2],
);
assert.ok(
  snapshot.unknowns.some(({ harness, fact }) =>
    harness === AgentRunHarness.ClaudeCode && fact === "account.allowanceWindows"
  ),
  "facts with no provider surface are called out as unknown",
);
assert.ok(
  !snapshot.unknowns.some(({ harness, fact }) =>
    harness === AgentRunHarness.Codex && fact === "account.allowanceWindows"
  ),
  "an observed non-empty allowance list is not unknown",
);

const isolated = await readHarnessDetails({
  deps: {
    now: () => new Date(OBSERVED_AT),
    readRegistryProvenance: () => ({ acpxVersion: "0.13.1", registeredAgentNames: [] }),
    readPreferences: () => ({
      path: "/fixture/preferences.md",
      content: "owner content survives\n",
      error: null,
    }),
    observeCapability: async (harness) => {
      if (harness === AgentRunHarness.Codex) throw new Error("codex ACP session failed");
      return capability(harness);
    },
    readCodexPayloads: async () => ({ account: CODEX_ACCOUNT_READ, rateLimits: CODEX_RATE_LIMITS_READ }),
    readCursorPayloads: async () => { throw new Error("cursor account failed"); },
  },
});
assert.equal(isolated.preferences.content, "owner content survives\n");
assert.equal(
  isolated.capabilities.harnesses.find(({ harness }) => harness === AgentRunHarness.Codex)?.error,
  "codex ACP session failed",
  "a thrown observer failure is converted to one harness-local row",
);
assert.deepEqual(
  isolated.account.find(({ harness }) => harness === AgentRunHarness.Codex)?.account,
  { plan: "prolite" },
  "a Codex capability failure cannot erase its independently observed account",
);
assert.equal(
  isolated.account.find(({ harness }) => harness === AgentRunHarness.Cursor)?.errors[0],
  "cursor account failed",
);
assert.equal(
  isolated.capabilities.harnesses.find(({ harness }) => harness === AgentRunHarness.Cursor)?.session?.models?.currentModelId,
  "launch-model",
  "an account failure cannot erase that harness capability or another harness",
);

const baseline = await readHarnessDetails({
  harnesses: [AgentRunHarness.Codex],
  includeBaselineCandidates: true,
  deps: {
    readRegistryProvenance: () => ({ acpxVersion: "0.13.1", registeredAgentNames: ["codex"] }),
    readPreferences: () => ({ path: "/fixture/preferences.md", source: null, content: null, error: null }),
    observeCapability: async () => ({
      ...capability(AgentRunHarness.Codex),
      session: {
        models: { currentModelId: "launch-model", availableModelIds: ["launch-model"] },
        configOptions: [{
          type: "select",
          id: "effort",
          name: "Effort",
          category: "thought_level",
          currentValue: "high",
          options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }],
        }],
        usage: null,
      },
    }),
    readCodexPayloads: async () => ({ account: null, rateLimits: null }),
  },
});
assert.deepEqual(baseline.capabilities.harnesses[0]?.baselineCandidate, {
  model: "launch-model",
  effort: "high",
  availableEfforts: ["low", "high"],
});

const inspection = {
  harness: AgentRunHarness.ClaudeCode,
  model: "claude-fable-5[1m]",
  effort: null,
} as const;
const inspectedCalls: unknown[] = [];
const inspected = await readHarnessDetails({
  inspect: [inspection],
  includeBaselineCandidates: true,
  deps: {
    readRegistryProvenance: () => ({ acpxVersion: "0.13.1", registeredAgentNames: ["claude"] }),
    readPreferences: () => ({ path: "/fixture/preferences.md", source: null, content: null, error: null }),
    observeCapability: async (harness, _observedAt, requestedInspection) => {
      inspectedCalls.push({ harness, requestedInspection });
      return {
        ...capability(harness),
        requestedInspection: requestedInspection ?? null,
        session: {
          models: { currentModelId: inspection.model, availableModelIds: [inspection.model] },
          configOptions: [],
          usage: null,
        },
        confirmation: { model: inspection.model },
      };
    },
  },
});
assert.deepEqual(inspectedCalls, [{
  harness: AgentRunHarness.ClaudeCode,
  requestedInspection: { model: inspection.model, effort: null },
}]);
assert.deepEqual(
  inspected.capabilities.harnesses.map(({ harness }) => harness),
  [AgentRunHarness.ClaudeCode],
  "an inspect-only request opens only the requested harness",
);
assert.equal(
  inspected.capabilities.harnesses[0]?.baselineCandidate,
  null,
  "an exact inspected candidate is never exposed as an unpinned baseline proposal",
);

await assert.rejects(
  readHarnessDetails({ inspect: [inspection, { ...inspection, model: "second" }] }),
  /duplicate inspection.*claude-code/i,
);

process.stdout.write("ok — harness snapshot keeps preferences, ACP capabilities, and account facts isolated\n");
