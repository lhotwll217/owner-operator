import { existsSync, readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join, resolve } from "node:path";
import { AgentRunStatus } from "@owner-operator/core";
import {
  configuredOwnerOperatorTools,
  createOoSession,
  createOwnerOperatorSession,
  lastAssistantError,
  lastAssistantText,
  ooProvenance,
  shutdownSessionExtensions,
} from "../../src/agent/agent";
import { startDaemon, type RunningDaemon } from "../../src/daemon/runtime";
import { stateDatabasePath } from "../../src/shared/paths";
import { buildMarkDoneBehaviorFixture } from "./mark-done-fixture.mjs";
import { createEvalSandboxUserEnvironment } from "../sandbox-user";

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
const sandboxEnvironment = createEvalSandboxUserEnvironment({
  root,
  sourcePiAgentDir: input.sourcePiAgentDir,
  protectedOwnerPaths: input.protectedOwnerPaths,
  modelSettings: input.modelSettings,
});

let daemon: RunningDaemon | undefined;
let created: Awaited<ReturnType<typeof createOwnerOperatorSession>> | undefined;
let daemonStopped = false;
let trialResult: Record<string, unknown> | undefined;
let trialError: unknown;
const traceEvents: Array<Record<string, unknown>> = [];

try {
  daemon = await startDaemon({
    port: 0,
    watch: false,
    enableEnrichment: false,
    monitor: { scan: async () => [], intervalMs: 60 * 60 * 1_000 },
    scheduler: { tickMs: 60 * 60 * 1_000 },
    agentRuns: {
      maxConcurrent: 0,
      tickMs: 60 * 60 * 1_000,
      launcher: Object.assign(
        async () => { throw new Error("behavioral eval executor must never launch a child"); },
        { reapOrphans: async () => undefined },
      ),
    },
  });

  const sessionManager = createOoSession(ooProvenance("chat"));
  sessionManager.appendMessage({ role: "user", content: input.parentContext, timestamp: Date.now() });
  const fixture = buildMarkDoneBehaviorFixture({
    root,
    taskCwd,
    parentThreadId: sessionManager.getSessionId(),
    childSessionId: input.childSessionId,
    sentinelSessionId: input.sentinelSessionId,
    parentContext: input.parentContext,
    result: input.result,
    shouldMarkDone: input.shouldMarkDone,
  });
  for (const row of fixture.rows) daemon.state.recordObservation(row);
  const stateBefore = captureState(daemon, fixture.expected, fixture.rows);

  created = await createOwnerOperatorSession("chat", { cwd: taskCwd, sessionManager });
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
    sessionId: sessionManager.getSessionId(),
    toolRoster: [...created.toolNames],
    configuredToolRoster: [...configuredOwnerOperatorTools(ooHome)],
    traceEvents,
    completion: { outcome: completed.status, childSessionId: completed.childSessionId },
    stateBefore,
    stateAfter,
    sandbox: {
      isolated: true,
      daemonStopped: false,
      leasesRemaining: leaseCount(ooHome),
      diagnosticsRetained: false,
    },
  };
} catch (error) {
  trialError = error;
} finally {
  if (created) {
    await shutdownSessionExtensions(created.session);
    created.session.dispose();
  }
  if (daemon) {
    const port = daemon.port;
    await daemon.close();
    daemonStopped = !existsSync(join(ooHome, "daemon.json")) && !await portResponds(port);
  }
}

if (!trialResult) {
  sandboxEnvironment.finalize({
    teardownVerified: false,
    diagnostic: {
      kind: "behavioral-trial-failed",
      error: trialError instanceof Error ? trialError.message : String(trialError ?? "unknown error"),
      daemonStopped,
      leasesRemaining: leaseCount(ooHome),
    },
  });
  throw trialError ?? new Error("behavioral trial produced no result");
}
(trialResult.sandbox as Record<string, unknown>).daemonStopped = daemonStopped;
(trialResult.sandbox as Record<string, unknown>).leasesRemaining = leaseCount(ooHome);
(trialResult as Record<string, unknown>).sessionTrace = readSessionTrace(
  ooHome,
  String(trialResult.sessionId),
);
const preservedDiagnostics = sandboxEnvironment.finalize({
  teardownVerified: daemonStopped && leaseCount(ooHome) === 0,
  diagnostic: {
    kind: "behavioral-trial-teardown-unverified",
    caseId: input.caseId,
    daemonStopped,
    leasesRemaining: leaseCount(ooHome),
  },
});
(trialResult.sandbox as Record<string, unknown>).preservedDiagnostics = preservedDiagnostics;
process.stdout.write(`OO_BEHAVIOR_RESULT=${Buffer.from(JSON.stringify(trialResult)).toString("base64url")}\n`);

function completionTurnPromise(
  session: Awaited<ReturnType<typeof createOwnerOperatorSession>>["session"],
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

function leaseCount(home: string): number {
  const dir = join(home, "agent-runs", "process-leases");
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".json")).length : 0;
}

function readSessionTrace(home: string, sessionId: string): string | null {
  const sessions = join(home, "sessions");
  if (!existsSync(sessions)) return null;
  const relative = readdirSync(sessions, { recursive: true })
    .map(String)
    .find((file) => file.endsWith(".jsonl") && file.includes(sessionId));
  return relative ? readFileSync(join(sessions, relative), "utf8") : null;
}

async function portResponds(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(250) });
    return true;
  } catch {
    return false;
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
