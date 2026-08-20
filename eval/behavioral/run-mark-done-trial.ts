import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { AgentRunStatus } from "@owner-operator/core";
import {
  configuredOwnerOperatorTools,
  lastAssistantError,
  lastAssistantText,
} from "../../src/agent/agent";
import { type RunningDaemon } from "../../src/daemon/runtime";
import { stateDatabasePath } from "../../src/shared/paths";
import { buildMarkDoneBehaviorFixture } from "./mark-done-fixture.mjs";
import { createSandboxUser } from "../sandbox-user";

interface TrialInput {
  caseId: string;
  parentContext: string;
  result: string;
  shouldMarkDone: boolean;
  childSessionId: string;
  sentinelSessionId: string;
  timeoutMs?: number;
  sourcePiAgentDir: string;
  protectedOwnerPaths: string[];
  modelSettings: {
    defaultProvider: string;
    defaultModel: string;
    defaultThinkingLevel?: string;
    transport?: string;
  };
}

const input = readInput(process.argv[2]);
const root = requiredEnv("OO_EVAL_SANDBOX");
const ooHome = requiredEnv("OO_HOME");
const userHome = requiredEnv("HOME");
const taskCwd = requiredEnv("OO_EVAL_CWD");
assertInside(root, userHome, "HOME");
assertInside(root, ooHome, "OO_HOME");
assertInside(root, taskCwd, "task cwd");
if (process.env.OO_EVAL_READ_ONLY || process.env.OO_EVAL_BASELINE_PROMPT) {
  throw new Error("behavioral trial must use the production prompt and full configured roster");
}
const sandboxEnvironment = await createSandboxUser({
  profile: "deterministic-harness",
  root,
  sourcePiAgentDir: input.sourcePiAgentDir,
  protectedOwnerPaths: input.protectedOwnerPaths,
  modelSettings: input.modelSettings,
});

const daemon = sandboxEnvironment.daemon;
let created: Awaited<ReturnType<typeof sandboxEnvironment.createProductionSession>> | undefined;
let trialResult: Record<string, unknown> | undefined;
let trialError: unknown;
const traceEvents: Array<Record<string, unknown>> = [];

try {
  created = await sandboxEnvironment.createProductionSession({ parentContext: input.parentContext });
  const fixture = buildMarkDoneBehaviorFixture({
    root,
    taskCwd,
    parentThreadId: created.sessionId,
    childSessionId: input.childSessionId,
    sentinelSessionId: input.sentinelSessionId,
    parentContext: input.parentContext,
    result: input.result,
    shouldMarkDone: input.shouldMarkDone,
  });
  for (const row of fixture.rows) daemon.state.recordObservation(row);
  const stateBefore = captureState(daemon, fixture.expected, fixture.rows);

  const endOfCompletionTurn = completionTurnPromise(created.session, traceEvents, input.timeoutMs ?? 10 * 60 * 1_000);
  const run = daemon.state.createAgentRun(fixture.run.create);
  const completed = daemon.state.finishAgentRun(run.id, fixture.run.outcome);
  if (!completed || completed.status !== AgentRunStatus.Completed) {
    throw new Error("controlled delegated run did not reach completed lifecycle");
  }
  await endOfCompletionTurn;
  await created.session.waitForIdle();
  const modelError = lastAssistantError(created.session);
  if (modelError) throw new Error(`subject model failed: ${modelError}`);
  const stateAfter = captureState(daemon, fixture.expected, fixture.rows);

  trialResult = {
    version: 1,
    caseId: input.caseId,
    assistantText: lastAssistantText(created.session),
    modelLabel: created.modelLabel,
    sessionId: created.sessionId,
    toolRoster: [...created.toolNames],
    configuredToolRoster: [...configuredOwnerOperatorTools(ooHome)],
    traceEvents,
    completion: { outcome: completed.status, childSessionId: completed.childSessionId },
    stateBefore,
    stateAfter,
    sandbox: {
      isolated: true,
      credentialFileRemoved: sandboxEnvironment.credentialFileRemoved(),
      daemonStopped: false,
      leasesRemaining: sandboxEnvironment.leasesRemaining(),
      diagnosticsRetained: false,
    },
    sessionTrace: sandboxEnvironment.readSessionTrace(created.sessionId),
  };
} catch (error) {
  trialError = error;
}

if (!trialResult) {
  await sandboxEnvironment.close({
    kind: "behavioral-trial-failed",
    error: trialError instanceof Error ? trialError.message : String(trialError ?? "unknown error"),
  });
  throw trialError ?? new Error("behavioral trial produced no result");
}
const closeResult = await sandboxEnvironment.close({
  kind: "behavioral-trial-teardown",
  caseId: input.caseId,
});
(trialResult.sandbox as Record<string, unknown>).daemonStopped = closeResult.daemonStopped;
(trialResult.sandbox as Record<string, unknown>).leasesRemaining = closeResult.leasesRemaining;
(trialResult.sandbox as Record<string, unknown>).preservedDiagnostics = closeResult.preservedDiagnostics;
process.stdout.write(`OO_BEHAVIOR_RESULT=${Buffer.from(JSON.stringify(trialResult)).toString("base64url")}\n`);

function completionTurnPromise(
  session: Awaited<ReturnType<typeof sandboxEnvironment.createProductionSession>>["session"],
  events: Array<Record<string, unknown>>,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`timed out after ${timeoutMs}ms waiting for the completion-driven parent turn`));
    }, timeoutMs);
    const unsubscribe = session.subscribe((event: any) => {
      if (event.type === "tool_execution_start") {
        events.push({ event: "tool_call", id: event.toolCallId, tool: event.toolName, args: event.args });
      } else if (event.type === "tool_execution_end") {
        events.push({
          event: "tool_result",
          id: event.toolCallId,
          tool: event.toolName,
          isError: Boolean(event.isError),
          result: event.result ?? null,
        });
      } else if (event.type === "message_end" && event.message?.role === "assistant") {
        const { usage, stopReason, errorMessage } = event.message;
        events.push({ event: "turn", stopReason, usage, ...(errorMessage ? { errorMessage } : {}) });
      } else if (event.type === "agent_end") {
        clearTimeout(timer);
        unsubscribe();
        resolvePromise();
      }
    });
  });
}

function captureState(
  running: RunningDaemon,
  expected: { childSessionId: string; sentinelSessionId: string },
  rows: Array<{ id: string; transcriptPath: string }>,
) {
  const ids = [expected.childSessionId, expected.sentinelSessionId];
  const database = new DatabaseSync(stateDatabasePath(), { readOnly: true });
  try {
    const rawThreadStates = Object.fromEntries(ids.map((id) => {
      const row = database.prepare(`
        SELECT detail.state AS state
        FROM thread_details detail
        WHERE detail.thread_id = ?
        ORDER BY detail.version DESC LIMIT 1
      `).get(id) as { state?: string } | undefined;
      return [id, row?.state ?? null];
    }));
    return {
      rawThreadStates,
      activeIds: running.state.listCurrentSessionState().map(({ id }) => id),
      transcriptExists: Object.fromEntries(rows.map((row) => [row.id, existsSync(row.transcriptPath)])),
    };
  } finally {
    database.close();
  }
}

function readInput(value: string | undefined): TrialInput {
  if (!value) throw new Error("behavioral trial input is required");
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as TrialInput;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return resolve(value);
}

function assertInside(rootPath: string, candidate: string, label: string): void {
  const rootPrefix = `${resolve(rootPath)}/`;
  if (!resolve(candidate).startsWith(rootPrefix)) throw new Error(`${label} must be inside the trial sandbox`);
}
