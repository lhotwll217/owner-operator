import assert from "node:assert";
import type { AcpRuntime } from "acpx/runtime";
import {
  AgentRunHarness,
  AgentRunStatus,
  type AgentRun,
  type AgentRunActivityUpdate,
} from "@owner-operator/core";
import { codexAcpAgentCommand, createAcpLauncher } from "./acp-launcher";

const codexCommand = codexAcpAgentCommand();
assert.match(codexCommand, /codex-acp\/dist\/index\.js"?$/, "Codex uses Owner Operator's pinned adapter");
assert.doesNotMatch(codexCommand, /npx|0\.0\.44/, "Codex does not fall back to acpx's stale registry command");

const oversized = `${"x".repeat(70 * 1024)}newest-tail`;
const handle = { agentSessionId: "child-session", acpxRecordId: "acpx-record" };
const appliedOptions: Array<{ key: string; value: string }> = [];
const turnTexts: string[] = [];
const runtimeCalls: string[] = [];
const runtime = {
  ensureSession: async () => { runtimeCalls.push("ensure"); return handle; },
  getCapabilities: async () => {
    runtimeCalls.push("capabilities");
    return { controls: ["session/set_config_option"], configOptionKeys: ["model", "reasoning_effort"] };
  },
  setConfigOption: async ({ key, value }: { key: string; value: string }) => {
    runtimeCalls.push("set-effort");
    appliedOptions.push({ key, value });
  },
  getStatus: async () => {
    runtimeCalls.push("status");
    return {
      models: { currentModelId: "harness-resolved-model" },
      details: { configOptions: [{ id: "reasoning_effort", currentValue: "ultra" }] },
    };
  },
  startTurn: ({ text }: { text: string }) => {
    runtimeCalls.push("turn");
    turnTexts.push(text);
    return {
      events: (async function* () {
        yield { type: "text_delta", stream: "output", text: oversized };
      })(),
      result: Promise.resolve({ status: "completed" }),
    };
  },
} as unknown as AcpRuntime;

const run: AgentRun = {
  id: "run-1",
  harness: AgentRunHarness.ClaudeCode,
  task: "produce a report",
  cwd: process.cwd(),
  parentThreadId: "parent",
  model: null,
  effort: "ultra",
  effortApplied: false,
  harnessIdentity: { observed: false },
  depth: 1,
  status: AgentRunStatus.Running,
  createdAt: "2026-07-20T00:00:00.000Z",
  startedAt: "2026-07-20T00:00:00.000Z",
  finishedAt: null,
  activity: null,
  lastActivityAt: null,
  childSessionId: null,
  acpxRecordId: null,
  resultTail: null,
  error: null,
  resumeOfRunId: null,
  timeoutSeconds: 3_600,
};

const activity: AgentRunActivityUpdate[] = [];
const result = await createAcpLauncher({ runtimeFactory: () => runtime })({
  run,
  resumeSessionId: null,
  signal: new AbortController().signal,
  onActivity: (update) => activity.push(update),
});

assert.equal(result.status, AgentRunStatus.Completed);
assert.equal(result.childSessionId, handle.agentSessionId);
assert.equal(result.acpxRecordId, handle.acpxRecordId);
assert.ok(Buffer.byteLength(result.resultText) <= 64 * 1024, "one oversized event stays within the launcher cap");
assert.ok(result.resultText.endsWith("newest-tail"), "the rolling buffer preserves the newest bytes");
assert.deepEqual(activity[0], { childSessionId: "child-session", acpxRecordId: "acpx-record" });
assert.deepEqual(appliedOptions, [{ key: "reasoning_effort", value: "ultra" }], "the launcher applies the exact selected identity");
assert.deepEqual(activity[1], { effortApplied: true }, "successful application becomes durable audit activity");
assert.deepEqual(activity[2], {
  harnessIdentity: { observed: true, model: "harness-resolved-model", effort: "ultra" },
}, "effective identity is independently read back from harness status");

for (const [status, expected] of [
  [{}, { observed: false }],
  [{ models: { currentModelId: "  " }, details: { configOptions: [{ id: "reasoning_effort", currentValue: "turbo" }] } }, { observed: false }],
  [{ models: { currentModelId: "model-only" } }, { observed: true, model: "model-only" }],
  [{ details: { configOptions: [{ id: "reasoning_effort", currentValue: "max" }] } }, { observed: true, effort: "max" }],
] as const) {
  const observed: AgentRunActivityUpdate[] = [];
  const statusRuntime = { ...runtime, getStatus: async () => status } as unknown as AcpRuntime;
  await createAcpLauncher({ runtimeFactory: () => statusRuntime })({
    run: { ...run, effort: null }, resumeSessionId: null, signal: new AbortController().signal,
    onActivity: (update) => observed.push(update),
  });
  assert.deepEqual(observed[1], { harnessIdentity: expected }, "status observation preserves only actual supported facts");
}
assert.deepEqual(runtimeCalls.slice(0, 5), ["ensure", "capabilities", "set-effort", "status", "turn"], "effort and identity observation happen before the turn");
assert.match(turnTexts[0] ?? "", /^produce a report\n\n/);
assert.match(turnTexts[0] ?? "", /Do the work yourself/i);
assert.match(turnTexts[0] ?? "", /do not launch nested or background agents/i, "every child task envelope forbids nested agents");

const unadvertisedOptions: Array<{ key: string; value: string }> = [];
const unadvertisedRuntime = {
  ensureSession: async () => handle,
  getCapabilities: async () => ({ controls: ["session/set_config_option"], configOptionKeys: ["model"] }),
  setConfigOption: async (option: { key: string; value: string }) => { unadvertisedOptions.push(option); },
  startTurn: runtime.startTurn,
} as unknown as AcpRuntime;
await createAcpLauncher({ runtimeFactory: () => unadvertisedRuntime })({
  run,
  resumeSessionId: null,
  signal: new AbortController().signal,
  onActivity: () => undefined,
});
assert.deepEqual(unadvertisedOptions, [], "effort is not applied when the session does not advertise reasoning_effort");

const backendOnlyRuntime = {
  ensureSession: async () => ({ backendSessionId: "backend-session", acpxRecordId: "backend-record" }),
  startTurn: () => ({
    events: (async function* () {})(),
    result: Promise.resolve({ status: "completed" }),
  }),
} as unknown as AcpRuntime;
const backendIdentity = await createAcpLauncher({ runtimeFactory: () => backendOnlyRuntime })({
  run,
  resumeSessionId: null,
  signal: new AbortController().signal,
  onActivity: () => undefined,
});
assert.equal(
  backendIdentity.childSessionId,
  "backend-session",
  "ACP backends without a separate native id still retain their resumable session identity",
);

let terminationChecks = 0;
let releases = 0;
let verifiedPids: readonly number[] | undefined;
const closeVerifiedRuntime = { ...runtime, close: async () => undefined } as unknown as AcpRuntime;
await createAcpLauncher({
  leasedRuntimeFactory: () => ({
    runtime: closeVerifiedRuntime,
    sessionStore: { load: async () => null } as never,
    leaseId: "lease-close-proof",
    release: () => { releases += 1; },
    processTreePids: async () => [701, 702],
    terminate: async (trackedPids) => { terminationChecks += 1; verifiedPids = trackedPids; return false; },
  }),
})({ run, resumeSessionId: null, signal: new AbortController().signal, onActivity: () => undefined });
assert.equal(terminationChecks, 1, "normal runtime close independently verifies process-tree termination");
assert.deepEqual(verifiedPids, [701, 702], "normal close verifies the PID set captured before wrapper exit");
assert.equal(releases, 0, "failed close verification retains the process lease");

process.stdout.write("ok — ACP launcher maps native/backend identity, outcome, and bounded output\n");
