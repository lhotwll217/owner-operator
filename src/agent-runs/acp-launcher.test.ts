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
const runtime = {
  ensureSession: async () => handle,
  startTurn: () => ({
    events: (async function* () {
      yield { type: "text_delta", stream: "output", text: oversized };
    })(),
    result: Promise.resolve({ status: "completed" }),
  }),
} as unknown as AcpRuntime;

const run: AgentRun = {
  id: "run-1",
  harness: AgentRunHarness.ClaudeCode,
  task: "produce a report",
  cwd: process.cwd(),
  parentThreadId: "parent",
  model: null,
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

process.stdout.write("ok — ACP launcher maps native/backend identity, outcome, and bounded output\n");
