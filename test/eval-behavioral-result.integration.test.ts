import assert from "node:assert";
import { normalizeBehavioralTrialResult } from "../eval/providers/behavioral-result.mjs";

const payload = {
  version: 1,
  caseId: "delegated-child-confidently-finished",
  assistantText: "The child completed the checklist and validation passed.",
  modelLabel: "test-provider/test-model",
  sessionId: "parent-129",
  toolRoster: ["read", "mark_thread_done"],
  configuredToolRoster: ["read", "mark_thread_done"],
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
    { event: "tool_call", id: "call-1", tool: "mark_thread_done", args: { ids: ["child-129"] } },
    {
      event: "tool_result",
      id: "call-1",
      tool: "mark_thread_done",
      isError: false,
      result: { details: { marked: [{ id: "child-129" }], alreadyDoneIds: [], missingIds: [] } },
    },
    ...payload.traceEvents,
  ],
});
assert.deepEqual(successfulTool.metadata.toolExecutions[0], {
  id: "call-1",
  name: "mark_thread_done",
  input: { ids: ["child-129"] },
  isError: false,
  resultChars: 79,
  result: { details: { marked: [{ id: "child-129" }], alreadyDoneIds: [], missingIds: [] } },
});

const brokenTrace = normalizeBehavioralTrialResult({
  ...payload,
  traceEvents: [{ event: "tool_call", id: "call-1", tool: "mark_thread_done", args: { ids: ["child-129"] } }],
});
assert.equal(brokenTrace.metadata.harnessValid, false);
assert.match(brokenTrace.providerError!, /incomplete tool execution/);

const brokenTeardown = normalizeBehavioralTrialResult({
  ...payload,
  sandbox: { ...payload.sandbox, daemonStopped: false },
});
assert.equal(brokenTeardown.metadata.harnessValid, false);
assert.match(brokenTeardown.providerError!, /teardown/);

process.stdout.write("ok — behavioral result: real tool events normalize while target failures remain valid baseline data\n");
