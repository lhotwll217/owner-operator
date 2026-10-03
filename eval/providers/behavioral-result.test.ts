import assert from "node:assert";
import { normalizeBehavioralTrialResult } from "./behavioral-result.mjs";

const payload = {
  version: 1,
  caseId: "delegated-child-confidently-finished",
  assistantText: "The child completed the checklist and validation passed.",
  modelLabel: "test-provider/test-model",
  sessionId: "parent-129",
  toolRoster: ["read", "bash"],
  configuredToolRoster: ["read", "bash"],
  traceEvents: [
    { event: "turn", stopReason: "stop", usage: { input: 10, output: 5, cacheRead: 2, totalTokens: 17, cost: { total: 0.01 } } },
  ],
  completion: { outcome: "completed", childSessionId: "child-129" },
  stateBefore: {
    rawThreadStates: { "child-129": "working", "sentinel-129": "needs-you" },
    activeIds: ["child-129", "sentinel-129"],
    transcriptExists: { "child-129": true, "sentinel-129": true },
  },
  stateAfter: {
    rawThreadStates: { "child-129": "working", "sentinel-129": "needs-you" },
    activeIds: ["child-129", "sentinel-129"],
    transcriptExists: { "child-129": true, "sentinel-129": true },
  },
  sandbox: {
    isolated: true,
    credentialFileRemoved: true,
    daemonStopped: true,
    leasesRemaining: 0,
    diagnosticsRetained: true,
  },
};

const baselineFailure = normalizeBehavioralTrialResult(payload);
assert.equal(baselineFailure.providerError, null, "missing target behavior is a baseline grade, not a harness failure");
assert.equal(baselineFailure.metadata.toolExecutions.length, 0);
assert.equal(baselineFailure.metadata.tokensTotal, 17);
assert.equal(baselineFailure.metadata.harnessValid, true);

const successfulTool = normalizeBehavioralTrialResult({
  ...payload,
  traceEvents: [
    { event: "tool_call", id: "call-1", tool: "bash", args: { command: "oo session-state done child-129" } },
    {
      event: "tool_result",
      id: "call-1",
      tool: "bash",
      isError: false,
      result: { content: [{ type: "text", text: "done     child-129\n" }] },
    },
    ...payload.traceEvents,
  ],
});
assert.deepEqual(successfulTool.metadata.toolExecutions[0], {
  id: "call-1",
  name: "bash",
  input: { command: "oo session-state done child-129" },
  index: null,
  isError: false,
  resultChars: 59,
  result: { content: [{ type: "text", text: "done     child-129\n" }] },
});

const brokenTrace = normalizeBehavioralTrialResult({
  ...payload,
  traceEvents: [{ event: "tool_call", id: "call-1", tool: "bash", args: { command: "oo session-state done child-129" } }],
});
assert.equal(brokenTrace.metadata.harnessValid, false);
assert.match(brokenTrace.providerError!, /incomplete or malformed tool execution/);

const brokenTeardown = normalizeBehavioralTrialResult({
  ...payload,
  sandbox: { ...payload.sandbox, daemonStopped: false },
});
assert.equal(brokenTeardown.metadata.harnessValid, false);
assert.match(brokenTeardown.providerError!, /teardown/);

const missingStateComponent = normalizeBehavioralTrialResult({
  ...payload,
  stateAfter: { ...payload.stateAfter, activeIds: undefined },
});
assert.equal(missingStateComponent.metadata.harnessValid, false);
assert.match(missingStateComponent.providerError!, /state evidence/);

const unmatchedResult = normalizeBehavioralTrialResult({
  ...payload,
  traceEvents: [
    { event: "tool_result", id: "missing-call", tool: "bash", isError: false, result: {} },
    ...payload.traceEvents,
  ],
});
assert.equal(unmatchedResult.metadata.harnessValid, false);
assert.match(unmatchedResult.providerError!, /no matching call/);

const delegationTrial = normalizeBehavioralTrialResult({
  ...payload,
  caseId: "delegation-usage-explanation",
  behaviorProfile: "delegation-selection",
  behaviorClaim: "usage-explanation",
  behaviorExpected: { usedPercent: 63, remainingPercent: 37, usageAffectedRecommendation: true },
  completion: null,
  stateBefore: { userHarnessPreferences: "# neutral\n", delegatedBaselines: {}, agentRuns: [] },
  stateAfter: { userHarnessPreferences: "# neutral\n", delegatedBaselines: {}, agentRuns: [] },
  traceEvents: [
    {
      event: "tool_call", id: "details", tool: "bash",
      args: { command: "oo harness details --harness codex --harness claude-code --json" },
    },
    { event: "tool_result", id: "details", tool: "bash", isError: false, result: { content: [{ type: "text", text: "{}" }] } },
    ...payload.traceEvents,
  ],
});
assert.equal(delegationTrial.providerError, null, delegationTrial.providerError ?? "");
assert.equal(delegationTrial.metadata.behaviorProfile, "delegation-selection");
assert.deepEqual(delegationTrial.metadata.behaviorExpected, {
  usedPercent: 63,
  remainingPercent: 37,
  usageAffectedRecommendation: true,
});

process.stdout.write("ok — behavioral result: real tool events normalize while target failures remain valid baseline data\n");
