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

process.stdout.write("ok — eval tool gate: discovery may precede locator; scoped/direct reads may not\n");
