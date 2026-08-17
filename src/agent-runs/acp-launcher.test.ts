import assert from "node:assert";
import type { AcpRuntime } from "acpx/runtime";
import {
  AgentRunHarness,
  AgentRunStatus,
  type AgentRun,
  type AgentRunActivityUpdate,
} from "@owner-operator/core";
import { codexAcpAgentCommand, createAcpLauncher, cursorAcpAgentCommand } from "./acp-launcher";

const codexCommand = codexAcpAgentCommand();
assert.match(codexCommand, /codex-acp\/dist\/index\.js"?$/, "Codex uses Owner Operator's pinned adapter");
assert.doesNotMatch(codexCommand, /npx|0\.0\.44/, "Codex does not fall back to acpx's stale registry command");

// Cursor speaks ACP first-party: the resolved local CLI in server mode, no adapter package.
try {
  const cursorCommand = cursorAcpAgentCommand();
  assert.match(cursorCommand, /^"\/.*cursor-agent" acp$/, "Cursor runs the absolute local CLI as an ACP server");
} catch (error) {
  assert.match((error as Error).message, /cursor-agent CLI not found/,
    "a machine without the Cursor CLI gets the actionable resolution error");
}

// A relative PATH entry must still resolve to an absolute command: a later spawn from a
// different working directory would otherwise re-resolve it against the wrong location.
{
  const { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { isAbsolute, join } = await import("node:path");
  const { cursorAgentBinaryPath } = await import("./acp-launcher");
  const pathRoot = realpathSync(mkdtempSync(join(tmpdir(), "oo-cursor-path-")));
  mkdirSync(join(pathRoot, "bin"));
  writeFileSync(join(pathRoot, "bin", "cursor-agent"), "#!/bin/sh\n", { mode: 0o755 });
  const previousPath = process.env.PATH;
  const previousCwd = process.cwd();
  try {
    process.chdir(pathRoot);
    process.env.PATH = "bin";
    const resolved = cursorAgentBinaryPath();
    assert.ok(isAbsolute(resolved), "a relative PATH entry still yields an absolute command");
    assert.equal(resolved, join(pathRoot, "bin", "cursor-agent"));
  } finally {
    process.env.PATH = previousPath;
    process.chdir(previousCwd);
    rmSync(pathRoot, { recursive: true, force: true });
  }
}

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
  retryOfRunId: null,
  resumeOfRunId: null,
  timeoutSeconds: 3_600,
};

const activity: AgentRunActivityUpdate[] = [];
const result = await createAcpLauncher({ runtimeFactory: () => runtime })({
  run,
  turnIntent: { kind: "fresh" },
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
    run: { ...run, effort: null }, turnIntent: { kind: "fresh" }, signal: new AbortController().signal,
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
  turnIntent: { kind: "fresh" },
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
  turnIntent: { kind: "fresh" },
  signal: new AbortController().signal,
  onActivity: () => undefined,
});
assert.equal(
  backendIdentity.childSessionId,
  "backend-session",
  "ACP backends without a separate native id still retain their persistent session identity",
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
})({ run, turnIntent: { kind: "fresh" }, signal: new AbortController().signal, onActivity: () => undefined });
assert.equal(terminationChecks, 1, "normal runtime close independently verifies process-tree termination");
assert.deepEqual(verifiedPids, [701, 702], "normal close verifies the PID set captured before wrapper exit");
assert.equal(releases, 0, "failed close verification retains the process lease");

// A resume addresses both durable identities. Invalid acpx records fail before
// ensureSession can recreate the record and accidentally turn the follow-up into a fresh session.
const resumeRun = {
  ...run,
  id: "resumed-run",
  harness: AgentRunHarness.Codex,
  task: "answer a follow-up",
  childSessionId: "resumed-child",
  acpxRecordId: "completed-acpx-record",
  resumeOfRunId: "completed-run",
};
const resumeRecord = {
  acpxRecordId: "completed-acpx-record",
  acpSessionId: "backend-child",
  agentSessionId: "resumed-child",
  cwd: resumeRun.cwd,
  acpx: {},
};
let resumeEnsureInput: Record<string, unknown> | undefined;
const resumeRuntime = {
  ensureSession: async (input: Record<string, unknown>) => {
    resumeEnsureInput = input;
    return {
      sessionKey: "completed-acpx-record",
      agentSessionId: "resumed-child",
      backendSessionId: "backend-child",
      acpxRecordId: "completed-acpx-record",
    };
  },
  startTurn: () => ({
    events: (async function* () {})(),
    result: Promise.resolve({ status: "completed" }),
  }),
  close: async () => undefined,
} as unknown as AcpRuntime;
await createAcpLauncher({
  leasedRuntimeFactory: () => ({
    runtime: resumeRuntime,
    sessionStore: { load: async () => resumeRecord } as never,
    leaseId: "resume-lease",
    release: () => undefined,
    processTreePids: async () => [],
    terminate: async () => true,
  }),
})({
  run: resumeRun,
  turnIntent: {
    kind: "resume",
    childSessionId: "resumed-child",
    acpxRecordId: "completed-acpx-record",
  },
  signal: new AbortController().signal,
  onActivity: () => undefined,
});
assert.equal(resumeEnsureInput?.sessionKey, "completed-acpx-record", "resume reuses the exact acpx record id");
assert.equal(resumeEnsureInput?.resumeSessionId, "backend-child", "resume loads the record's exact ACP session id");

const identityCases = [
  {
    harness: AgentRunHarness.ClaudeCode,
    recordId: "claude-record",
    acpSessionId: "claude-acp-session",
    agentSessionId: undefined,
    childSessionId: "claude-acp-session",
  },
  {
    harness: AgentRunHarness.Codex,
    recordId: "codex-record",
    acpSessionId: "codex-acp-session",
    agentSessionId: "codex-native-session",
    childSessionId: "codex-native-session",
  },
  {
    harness: AgentRunHarness.Cursor,
    recordId: "cursor-record",
    acpSessionId: "cursor-acp-session",
    agentSessionId: "cursor-native-session",
    childSessionId: "cursor-native-session",
  },
] as const;
for (const identityCase of identityCases) {
  const record = {
    ...resumeRecord,
    acpxRecordId: identityCase.recordId,
    acpSessionId: identityCase.acpSessionId,
    ...(identityCase.agentSessionId ? { agentSessionId: identityCase.agentSessionId } : { agentSessionId: undefined }),
  };
  let ensureInput: Record<string, unknown> | undefined;
  const exactRuntime = {
    ...resumeRuntime,
    ensureSession: async (input: Record<string, unknown>) => {
      ensureInput = input;
      return {
        sessionKey: identityCase.recordId,
        acpxRecordId: identityCase.recordId,
        backendSessionId: identityCase.acpSessionId,
        ...(identityCase.agentSessionId ? { agentSessionId: identityCase.agentSessionId } : {}),
      };
    },
  } as unknown as AcpRuntime;
  await createAcpLauncher({
    leasedRuntimeFactory: () => ({
      runtime: exactRuntime,
      sessionStore: { load: async () => record } as never,
      leaseId: `${identityCase.harness}-identity-lease`,
      release: () => undefined,
      processTreePids: async () => [],
      terminate: async () => true,
    }),
  })({
    run: {
      ...resumeRun,
      harness: identityCase.harness,
      childSessionId: identityCase.childSessionId,
      acpxRecordId: identityCase.recordId,
    },
    turnIntent: {
      kind: "resume",
      childSessionId: identityCase.childSessionId,
      acpxRecordId: identityCase.recordId,
    },
    signal: new AbortController().signal,
    onActivity: () => undefined,
  });
  assert.equal(ensureInput?.sessionKey, identityCase.recordId, `${identityCase.harness} reuses its acpx record`);
  assert.equal(
    ensureInput?.resumeSessionId,
    identityCase.acpSessionId,
    `${identityCase.harness} resumes through the record's ACP session identity`,
  );
}

for (const identityCase of identityCases) {
  const record = {
    ...resumeRecord,
    acpxRecordId: identityCase.recordId,
    acpSessionId: identityCase.acpSessionId,
    ...(identityCase.agentSessionId ? { agentSessionId: identityCase.agentSessionId } : { agentSessionId: undefined }),
  };
  const failedResumeRun = {
    ...resumeRun,
    id: `${identityCase.harness}-failed-resume`,
    harness: identityCase.harness,
    status: AgentRunStatus.Failed,
    childSessionId: identityCase.childSessionId,
    acpxRecordId: identityCase.recordId,
    error: "resume load failed after its row was created",
  };
  const retryRun = {
    ...failedResumeRun,
    id: `${identityCase.harness}-retry-failed-resume`,
    status: AgentRunStatus.Running,
    error: null,
    retryOfRunId: failedResumeRun.id,
    resumeOfRunId: null,
  };
  let retryEnsureInput: Record<string, unknown> | undefined;
  let retryTurnCalls = 0;
  const retryRuntime = {
    ...resumeRuntime,
    ensureSession: async (input: Record<string, unknown>) => {
      retryEnsureInput = input;
      return {
        sessionKey: retryRun.id,
        acpxRecordId: retryRun.id,
        backendSessionId: identityCase.acpSessionId,
        ...(identityCase.agentSessionId ? { agentSessionId: identityCase.agentSessionId } : {}),
      };
    },
    startTurn: () => {
      retryTurnCalls += 1;
      return {
        events: (async function* () {})(),
        result: Promise.resolve({ status: "completed" }),
      };
    },
  } as unknown as AcpRuntime;
  await createAcpLauncher({
    leasedRuntimeFactory: () => ({
      runtime: retryRuntime,
      sessionStore: { load: async (id: string) => id === identityCase.recordId ? record : undefined } as never,
      leaseId: `${identityCase.harness}-retry-identity-lease`,
      release: () => undefined,
      processTreePids: async () => [],
      terminate: async () => true,
    }),
  })({
    run: retryRun,
    turnIntent: {
      kind: "retry",
      childSessionId: identityCase.childSessionId,
      acpxRecordId: identityCase.recordId,
    },
    signal: new AbortController().signal,
    onActivity: () => undefined,
  });
  assert.equal(retryEnsureInput?.sessionKey, retryRun.id, "retry creates its own acpx record");
  assert.equal(
    retryEnsureInput?.resumeSessionId,
    identityCase.acpSessionId,
    `${identityCase.harness} retry loads the ACP identity proven by the failed Resume's record`,
  );
  assert.equal(retryTurnCalls, 1);

  const freshRetryRuntime = {
    ...retryRuntime,
    ensureSession: async () => ({
      sessionKey: retryRun.id,
      acpxRecordId: retryRun.id,
      backendSessionId: "fresh-backend-session",
      ...(identityCase.agentSessionId ? { agentSessionId: "fresh-native-session" } : {}),
    }),
    startTurn: () => {
      retryTurnCalls += 1;
      return {
        events: (async function* () {})(),
        result: Promise.resolve({ status: "completed" }),
      };
    },
  } as unknown as AcpRuntime;
  await assert.rejects(
    () => createAcpLauncher({
      leasedRuntimeFactory: () => ({
        runtime: freshRetryRuntime,
        sessionStore: { load: async (id: string) => id === identityCase.recordId ? record : undefined } as never,
        leaseId: `${identityCase.harness}-retry-fallback-lease`,
        release: () => undefined,
        processTreePids: async () => [],
        terminate: async () => true,
      }),
    })({
      run: retryRun,
      turnIntent: {
        kind: "retry",
        childSessionId: identityCase.childSessionId,
        acpxRecordId: identityCase.recordId,
      },
      signal: new AbortController().signal,
      onActivity: () => undefined,
    }),
    /ACP retry failed.*(?:identity mismatch|fresh session)/i,
    `${identityCase.harness} Retry refuses a fresh fallback after a failed Resume`,
  );
  assert.equal(retryTurnCalls, 1, "a rejected Retry fallback never receives a turn");
}

let legacyRetryTurnCalls = 0;
await createAcpLauncher({
  leasedRuntimeFactory: () => ({
    runtime: {
      ...resumeRuntime,
      ensureSession: async () => ({
        sessionKey: "legacy-child-only-retry",
        acpxRecordId: "legacy-child-only-retry",
        backendSessionId: "legacy-child-identity",
      }),
      startTurn: () => {
        legacyRetryTurnCalls += 1;
        return {
          events: (async function* () {})(),
          result: Promise.resolve({ status: "completed" }),
        };
      },
    } as unknown as AcpRuntime,
    sessionStore: { load: async () => undefined } as never,
    leaseId: "legacy-child-only-retry-lease",
    release: () => undefined,
    processTreePids: async () => [],
    terminate: async () => true,
  }),
})({
  run: {
    ...resumeRun,
    id: "legacy-child-only-retry",
    status: AgentRunStatus.Running,
    childSessionId: "legacy-child-identity",
    acpxRecordId: null,
    retryOfRunId: "legacy-failure",
    resumeOfRunId: null,
  },
  turnIntent: { kind: "retry", childSessionId: "legacy-child-identity" },
  signal: new AbortController().signal,
  onActivity: () => undefined,
});
assert.equal(legacyRetryTurnCalls, 1, "legacy retry remains available from its sole durable child identity");

let fallbackTurnCalls = 0;
const freshFallbackRuntime = {
  ...resumeRuntime,
  ensureSession: async () => ({
    sessionKey: "completed-acpx-record",
    acpxRecordId: "completed-acpx-record",
    backendSessionId: "fresh-backend-session",
    agentSessionId: "fresh-child-session",
  }),
  startTurn: () => {
    fallbackTurnCalls += 1;
    return {
      events: (async function* () {})(),
      result: Promise.resolve({ status: "completed" }),
    };
  },
} as unknown as AcpRuntime;
await assert.rejects(
  () => createAcpLauncher({
    leasedRuntimeFactory: () => ({
      runtime: freshFallbackRuntime,
      sessionStore: { load: async () => resumeRecord } as never,
      leaseId: "resume-fresh-fallback",
      release: () => undefined,
      processTreePids: async () => [],
      terminate: async () => true,
    }),
  })({
    run: resumeRun,
    turnIntent: {
      kind: "resume",
      childSessionId: "resumed-child",
      acpxRecordId: "completed-acpx-record",
    },
    signal: new AbortController().signal,
    onActivity: () => undefined,
  }),
  /ACP resume failed.*(?:identity mismatch|fresh session)/i,
  "a valid pre-check cannot authorize a fresh handle returned by ensureSession",
);
assert.equal(fallbackTurnCalls, 0, "a fresh fallback never receives the follow-up turn");

await assert.rejects(
  () => createAcpLauncher({
    leasedRuntimeFactory: () => ({
      runtime: {
        ...resumeRuntime,
        startTurn: () => { throw new Error("ordinary failure after validated resume identity"); },
      } as unknown as AcpRuntime,
      sessionStore: { load: async () => resumeRecord } as never,
      leaseId: "resume-turn-failure",
      release: () => undefined,
      processTreePids: async () => [],
      terminate: async () => true,
    }),
  })({
    run: resumeRun,
    turnIntent: {
      kind: "resume",
      childSessionId: "resumed-child",
      acpxRecordId: "completed-acpx-record",
    },
    signal: new AbortController().signal,
    onActivity: () => undefined,
  }),
  (error: unknown) => error instanceof Error
    && error.message.includes("ACP turn failed for resumed-run")
    && error.message.includes("ordinary failure after validated resume identity")
    && !error.message.includes("ACP resume failed"),
  "a post-identity turn failure is not misclassified as a Resume load failure",
);

for (const [label, record, expected] of [
  ["missing", undefined, /session record not found.*refusing to create a fresh session/i],
  ["mismatched", { ...resumeRecord, agentSessionId: "some-other-child" }, /identity mismatch/i],
  ["missing-acp-identity", { ...resumeRecord, acpSessionId: "" }, /no ACP session identity/i],
  ["closed", { ...resumeRecord, acpx: { reset_on_next_ensure: true } }, /was closed/i],
] as const) {
  let ensureCalls = 0;
  const invalidRuntime = {
    ...resumeRuntime,
    ensureSession: async () => { ensureCalls += 1; return {}; },
  } as unknown as AcpRuntime;
  await assert.rejects(
    () => createAcpLauncher({
      leasedRuntimeFactory: () => ({
        runtime: invalidRuntime,
        sessionStore: { load: async () => record } as never,
        leaseId: `resume-${label}`,
        release: () => undefined,
        processTreePids: async () => [],
        terminate: async () => true,
      }),
    })({
      run: resumeRun,
      turnIntent: {
        kind: "resume",
        childSessionId: "resumed-child",
        acpxRecordId: "completed-acpx-record",
      },
      signal: new AbortController().signal,
      onActivity: () => undefined,
    }),
    expected,
  );
  assert.equal(ensureCalls, 0, `${label} resume cannot fall through to fresh-session creation`);
}

process.stdout.write("ok — ACP launcher maps native/backend identity, outcome, and bounded output\n");
