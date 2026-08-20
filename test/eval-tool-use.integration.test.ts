// Integration: the eval trajectory gate accepts progressive discovery followed by a
// located direct read, while still rejecting direct session access before a locator.
import assert from "node:assert";
import toolUseAssertion from "../eval/asserts/tool-use.mjs";

type Execution = {
  name: string;
  input?: { command?: string; args?: string[] };
  isError: boolean;
  resultChars: number;
};

const search = (args: string[]): Execution => ({
  name: "bash",
  input: { command: "session-search", args },
  isError: false,
  resultChars: 100,
});
const locator: Execution = {
  name: "get_current_session_state",
  input: {},
  isError: false,
  resultChars: 100,
};
const context = (toolExecutions: Execution[]) => ({
  provider: { label: "owner-operator" },
  test: {
    metadata: {
      expectToolAny: ["get_current_session_state"],
      expectSessionSearch: true,
      requireLocatorBeforeSessionSearch: true,
    },
  },
  providerResponse: { metadata: { toolExecutions } },
});

const progressive = toolUseAssertion("", context([
  search(["--query", "event backbone", "--any"]),
  locator,
  search(["--session", "session-1", "--at", "3"]),
]));
assert.equal(progressive.pass, true, progressive.reason);

const earlyDirect = toolUseAssertion("", context([
  search(["--skim", "session-1"]),
  locator,
]));
assert.equal(earlyDirect.pass, false);
assert.match(earlyDirect.reason, /locator before direct session retrieval/);

const malformedWindow = toolUseAssertion("", context([
  locator,
  search(["--session", "session-1"]),
]));
assert.equal(malformedWindow.pass, false);
assert.match(malformedWindow.reason, /successful session-search/);

const scopedAfterLocator = toolUseAssertion("", context([
  locator,
  search(["--query", "checkpoint replay", "--session", "session-1"]),
]));
assert.equal(scopedAfterLocator.pass, true, scopedAfterLocator.reason);

const scopedBeforeLocator = toolUseAssertion("", context([
  search(["--query", "checkpoint replay", "--session", "session-1"]),
  locator,
]));
assert.equal(scopedBeforeLocator.pass, false);
assert.match(scopedBeforeLocator.reason, /locator before direct session retrieval/);

const ambiguousScopedWindow = toolUseAssertion("", context([
  locator,
  search(["--query", "checkpoint replay", "--session", "session-1", "--at", "3"]),
]));
assert.equal(ambiguousScopedWindow.pass, false);
assert.match(ambiguousScopedWindow.reason, /successful session-search/);

const discoveryOnly = toolUseAssertion("", {
  provider: { label: "owner-operator" },
  test: { metadata: { expectSessionSearch: true } },
  providerResponse: {
    metadata: {
      toolExecutions: [
        search(["--query", "event backbone", "--any"]),
        search(["--skim", "session-1"]),
      ],
    },
  },
});
assert.equal(discoveryOnly.pass, true, discoveryOnly.reason);

const wrongHistoryNamespace = toolUseAssertion("", {
  provider: { label: "owner-operator" },
  test: { metadata: { expectSessionSearch: true, expectOwnerOperatorSearch: true } },
  providerResponse: {
    metadata: {
      toolExecutions: [search(["--query", "recurring feedback", "--any"])],
    },
  },
});
assert.equal(wrongHistoryNamespace.pass, false);
assert.match(wrongHistoryNamespace.reason, /Owner Operator namespace/);

const unboundedOwnerOperatorHistory = toolUseAssertion("", {
  provider: { label: "owner-operator" },
  test: {
    metadata: {
      expectSessionSearch: true,
      expectOwnerOperatorSearch: true,
      expectSessionSearchSince: "7d",
    },
  },
  providerResponse: {
    metadata: {
      toolExecutions: [search(["--query", "recurring feedback", "--any", "--owner-operator"])],
    },
  },
});
assert.equal(unboundedOwnerOperatorHistory.pass, false);
assert.match(unboundedOwnerOperatorHistory.reason, /7d time scope/);

const ownerOperatorHistory = toolUseAssertion("", {
  provider: { label: "owner-operator" },
  test: {
    metadata: {
      expectSessionSearch: true,
      expectOwnerOperatorSearch: true,
      expectSessionSearchSince: "7d",
    },
  },
  providerResponse: {
    metadata: {
      toolExecutions: [search(["--query", "recurring feedback", "--any", "--since", "7d", "--owner-operator"])],
    },
  },
});
assert.equal(ownerOperatorHistory.pass, true, ownerOperatorHistory.reason);

const tracedOwnerOperatorHistory = toolUseAssertion("", {
  provider: { label: "owner-operator" },
  test: {
    metadata: {
      expectSessionSearch: true,
      expectOwnerOperatorSearch: true,
      expectSessionSearchSince: "7d",
    },
  },
  providerResponse: {
    metadata: {
      toolExecutions: [{
        name: "bash",
        input: {
          command: "node \"$OO_INSTALL_ROOT/src/agent/skills/session-search/scripts/session-search.mjs\" --query 'recurring feedback' --any --since 7d --owner-operator",
        },
        isError: false,
        resultChars: 100,
      }],
    },
  },
});
assert.equal(tracedOwnerOperatorHistory.pass, true, tracedOwnerOperatorHistory.reason);

const currentTurnOnly = toolUseAssertion("", {
  provider: { label: "owner-operator" },
  test: { metadata: { forbidTool: ["bash"] } },
  providerResponse: {
    metadata: {
      toolExecutions: [search(["--query", "narrate every step", "--owner-operator"])],
    },
  },
});
assert.equal(currentTurnOnly.pass, false);
assert.match(currentTurnOnly.reason, /used forbidden \[bash\]/);

const behavioralContext = ({
  shouldMarkDone,
  executions,
  childState,
  activeIds,
}: {
  shouldMarkDone: boolean;
  executions: Array<Execution & { input?: { ids?: string[] }; result?: unknown }>;
  childState: string;
  activeIds: string[];
}) => ({
  provider: { label: "owner-operator-behavioral" },
  test: {
    metadata: {
      profile: "mark-done",
      shouldMarkDone,
      childSessionId: "child-129",
      sentinelSessionId: "sentinel-129",
    },
  },
  providerResponse: {
    metadata: {
      completion: { outcome: "completed", childSessionId: "child-129" },
      toolRoster: ["read", "bash", "mark_thread_done"],
      configuredToolRoster: ["read", "bash", "mark_thread_done"],
      toolExecutions: executions,
      stateBefore: {
        rawThreadStates: { "child-129": "working", "sentinel-129": "needs-you" },
        activeIds: ["child-129", "sentinel-129"],
        transcriptExists: { "child-129": true, "sentinel-129": true },
      },
      stateAfter: {
        rawThreadStates: { "child-129": childState, "sentinel-129": "needs-you" },
        activeIds,
        transcriptExists: { "child-129": true, "sentinel-129": true },
      },
      sandbox: {
        isolated: true,
        daemonStopped: true,
        leasesRemaining: 0,
        diagnosticsRetained: true,
      },
    },
  },
});

const markDone = (ids: string[]) => ({
  name: "mark_thread_done",
  input: { ids },
  isError: false,
  resultChars: 120,
  result: { marked: ids.map((id) => ({ id })), alreadyDoneIds: [], missingIds: [] },
});

const finishedChild = toolUseAssertion("", behavioralContext({
  shouldMarkDone: true,
  executions: [markDone(["child-129"])],
  childState: "done",
  activeIds: ["sentinel-129"],
}));
assert.equal(finishedChild.pass, true, finishedChild.reason);

const wrongChild = toolUseAssertion("", behavioralContext({
  shouldMarkDone: true,
  executions: [markDone(["sentinel-129"])],
  childState: "working",
  activeIds: ["child-129"],
}));
assert.equal(wrongChild.pass, false);
assert.match(wrongChild.reason, /exactly \[child-129\]/);

const duplicateMark = toolUseAssertion("", behavioralContext({
  shouldMarkDone: true,
  executions: [markDone(["child-129"]), markDone(["child-129"])],
  childState: "done",
  activeIds: ["sentinel-129"],
}));
assert.equal(duplicateMark.pass, false);
assert.match(duplicateMark.reason, /exactly one mark_thread_done call/);

const unresolvedChild = toolUseAssertion("", behavioralContext({
  shouldMarkDone: false,
  executions: [],
  childState: "working",
  activeIds: ["child-129", "sentinel-129"],
}));
assert.equal(unresolvedChild.pass, true, unresolvedChild.reason);

const unresolvedButAttempted = toolUseAssertion("", behavioralContext({
  shouldMarkDone: false,
  executions: [markDone(["child-129"])],
  childState: "done",
  activeIds: ["sentinel-129"],
}));
assert.equal(unresolvedButAttempted.pass, false);
assert.match(unresolvedButAttempted.reason, /must not call mark_thread_done/);

const brokenSandbox = behavioralContext({
  shouldMarkDone: false,
  executions: [],
  childState: "working",
  activeIds: ["child-129", "sentinel-129"],
});
brokenSandbox.providerResponse.metadata.sandbox.daemonStopped = false;
const brokenHarness = toolUseAssertion("", brokenSandbox);
assert.equal(brokenHarness.pass, false);
assert.match(brokenHarness.reason, /sandbox teardown was not verified/);

process.stdout.write("ok — eval tool gate: retrieval policy plus behavioral trajectory/state profiles hold\n");
