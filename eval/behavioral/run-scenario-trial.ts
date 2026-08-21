import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  AgentRunHarness,
  AgentRunStatus,
  approveDelegatedBaseline,
  loadDelegatedBaseline,
  loadDelegatedBaselines,
  type AgentRunEffort,
} from "@owner-operator/core";
import type { HarnessBaselineCandidate, HarnessDetails } from "../../src/agent-runs/harness-details";
import {
  configuredOwnerOperatorTools,
  lastAssistantError,
  lastAssistantText,
} from "../../src/agent/agent";
import type { RunningDaemon } from "../../src/daemon/runtime";
import { stateDatabasePath } from "../../src/shared/paths";
import { createSandboxUser } from "../sandbox-user";
import { materializeMarkDoneScenario } from "./scenario-operations";

/**
 * One Harbor-style trial lifecycle for every mutable behavioral sample:
 * configure -> create -> setup -> observe -> execute -> observe -> finalize.
 * Behavior-specific code implements OO environment operations and state views; it does
 * not own session, trace, failure, result, or teardown lifecycle.
 */

type DelegationClaim =
  | "natural-first-delegation"
  | "usage-explanation"
  | "approved-default-reuse";

type ModelSettings = {
  defaultProvider: string;
  defaultModel: string;
  defaultThinkingLevel?: string;
  transport?: string;
};

type CommonInput = {
  version: 1;
  caseId: string;
  parentContext: string;
  timeoutMs?: number;
  sourcePiAgentDir: string;
  protectedOwnerPaths: string[];
  modelSettings: ModelSettings;
};

type MarkDoneInput = CommonInput & {
  behaviorProfile: "mark-done";
  result: string;
  shouldMarkDone: boolean;
  childSessionId: string;
  sentinelSessionId: string;
};

type DelegationInput = CommonInput & {
  behaviorProfile: "delegation-selection";
  behaviorClaim: DelegationClaim;
  behaviorExpected: Record<string, unknown>;
  harnessRoster: string;
  harnessDetails: HarnessDetails[];
  baselineCandidate?: (HarnessBaselineCandidate & { harness: AgentRunHarness }) | null;
  approvedBaseline?: {
    harness: AgentRunHarness;
    model: string;
    effort: AgentRunEffort | null;
  } | null;
};

type TrialInput = MarkDoneInput | DelegationInput;
type SandboxEnvironment = Awaited<ReturnType<typeof createSandboxUser>>;
type ManagedSession = Awaited<ReturnType<SandboxEnvironment["createProductionSession"]>>;
type ScenarioContext = Record<string, unknown>;

type ScenarioAdapter = {
  configureSandbox?(environment: SandboxEnvironment): void;
  sessionOptions(): Parameters<SandboxEnvironment["createProductionSession"]>[0];
  setup(environment: SandboxEnvironment, created: ManagedSession): Promise<ScenarioContext>;
  capture(environment: SandboxEnvironment, context: ScenarioContext): unknown;
  execute(
    environment: SandboxEnvironment,
    created: ManagedSession,
    context: ScenarioContext,
    traceEvents: Array<Record<string, unknown>>,
  ): Promise<Record<string, unknown> | null>;
  resultMetadata(): Record<string, unknown>;
};

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
const adapter = createScenarioAdapter(input, { root, ooHome, taskCwd });
const traceEvents: Array<Record<string, unknown>> = [];
let trialResult: Record<string, unknown> | undefined;
let trialError: unknown;

try {
  adapter.configureSandbox?.(sandboxEnvironment);
  const created = await sandboxEnvironment.createProductionSession(adapter.sessionOptions());
  const expectedModelLabel = `${input.modelSettings.defaultProvider}/${input.modelSettings.defaultModel}`;
  if (created.modelLabel !== expectedModelLabel) {
    throw new Error(`behavioral subject model drift: expected ${expectedModelLabel}, observed ${created.modelLabel}`);
  }
  subscribeToTrajectory(created.session, traceEvents);
  const context = await adapter.setup(sandboxEnvironment, created);
  const stateBefore = adapter.capture(sandboxEnvironment, context);
  const completion = await adapter.execute(sandboxEnvironment, created, context, traceEvents);
  await created.session.waitForIdle();
  const modelError = lastAssistantError(created.session);
  if (modelError) throw new Error(`subject model failed: ${modelError}`);
  const stateAfter = adapter.capture(sandboxEnvironment, context);

  trialResult = {
    version: 1,
    caseId: input.caseId,
    behaviorProfile: input.behaviorProfile,
    ...adapter.resultMetadata(),
    assistantText: lastAssistantText(created.session),
    modelLabel: created.modelLabel,
    sessionId: created.sessionId,
    toolRoster: [...created.toolNames],
    configuredToolRoster: [...configuredOwnerOperatorTools(ooHome)],
    traceEvents,
    completion,
    stateBefore,
    stateAfter,
    sandbox: {
      isolated: true,
      credentialFilesUnavailable: sandboxEnvironment.credentialFilesUnavailable(),
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
    kind: "behavioral-scenario-failed",
    caseId: input.caseId,
    error: trialError instanceof Error ? trialError.message : String(trialError ?? "unknown error"),
  });
  throw trialError ?? new Error("behavioral trial produced no result");
}
const closeResult = await sandboxEnvironment.close({
  kind: "behavioral-scenario-teardown",
  caseId: input.caseId,
});
(trialResult.sandbox as Record<string, unknown>).daemonStopped = closeResult.daemonStopped;
(trialResult.sandbox as Record<string, unknown>).leasesRemaining = closeResult.leasesRemaining;
(trialResult.sandbox as Record<string, unknown>).preservedDiagnostics = closeResult.preservedDiagnostics;
process.stdout.write(`OO_BEHAVIOR_RESULT=${Buffer.from(JSON.stringify(trialResult)).toString("base64url")}\n`);

function createScenarioAdapter(
  scenario: TrialInput,
  paths: { root: string; ooHome: string; taskCwd: string },
): ScenarioAdapter {
  return scenario.behaviorProfile === "mark-done"
    ? markDoneAdapter(scenario, paths)
    : delegationAdapter(scenario, paths);
}

function markDoneAdapter(
  scenario: MarkDoneInput,
  paths: { root: string; taskCwd: string },
): ScenarioAdapter {
  return {
    sessionOptions: () => ({ parentContext: scenario.parentContext }),
    async setup(environment, created) {
      const fixture = materializeMarkDoneScenario({
        root: paths.root,
        taskCwd: paths.taskCwd,
        parentThreadId: created.sessionId,
        childSessionId: scenario.childSessionId,
        sentinelSessionId: scenario.sentinelSessionId,
        result: scenario.result,
        shouldMarkDone: scenario.shouldMarkDone,
      });
      for (const row of fixture.rows) environment.daemon.state.recordObservation(row);
      return { fixture };
    },
    capture(environment, context) {
      const fixture = context.fixture as ReturnType<typeof materializeMarkDoneScenario>;
      return captureMarkDoneState(environment.daemon, fixture.expected, fixture.rows);
    },
    async execute(environment, created, context) {
      const fixture = (context.fixture as ReturnType<typeof materializeMarkDoneScenario>);
      const endOfCompletionTurn = waitForAgentEnd(
        created.session,
        scenario.timeoutMs ?? 10 * 60 * 1_000,
      );
      const run = environment.daemon.state.createAgentRun(fixture.run.create);
      const completed = environment.daemon.state.finishAgentRun(run.id, fixture.run.outcome);
      if (!completed || completed.status !== AgentRunStatus.Completed) {
        throw new Error("controlled delegated run did not reach completed lifecycle");
      }
      await endOfCompletionTurn;
      return { outcome: completed.status, childSessionId: completed.childSessionId };
    },
    resultMetadata: () => ({}),
  };
}

function delegationAdapter(
  scenario: DelegationInput,
  paths: { ooHome: string },
): ScenarioAdapter {
  return {
    configureSandbox(environment) {
      writeFileSync(environment.paths.harnessRoster, scenario.harnessRoster);
      if (scenario.approvedBaseline) {
        approveDelegatedBaseline(scenario.approvedBaseline.harness, {
          model: scenario.approvedBaseline.model,
          effort: scenario.approvedBaseline.effort,
        }, environment.ooHome);
      }
    },
    sessionOptions: () => ({
      harnessAdapters: {
        readHarnessDetails: async ({ harnesses }) => {
          const selected = harnesses?.length
            ? scenario.harnessDetails.filter((detail) => harnesses.includes(detail.harness))
            : scenario.harnessDetails;
          return selected.map((detail) => structuredClone(detail));
        },
        proposeDelegatedBaseline: async (harness) => {
          const approved = loadDelegatedBaseline(harness, paths.ooHome);
          const candidate = scenario.baselineCandidate?.harness === harness
            ? {
                model: scenario.baselineCandidate.model,
                effort: scenario.baselineCandidate.effort,
                availableEfforts: scenario.baselineCandidate.availableEfforts,
              }
            : null;
          return {
            harness,
            approved,
            candidate,
            error: candidate ? null : `no controlled baseline candidate for ${harness}`,
            differs: candidate !== null && (
              candidate.model !== (approved?.model ?? null)
              || candidate.effort !== (approved?.effort ?? null)
            ),
          };
        },
      },
    }),
    async setup() {
      return {};
    },
    capture(environment) {
      return captureDelegationState(
        environment.daemon,
        environment.ooHome,
        environment.paths.harnessRoster,
      );
    },
    async execute(_environment, created) {
      await created.session.prompt(scenario.parentContext);
      return null;
    },
    resultMetadata: () => ({
      behaviorClaim: scenario.behaviorClaim,
      behaviorExpected: scenario.behaviorExpected,
    }),
  };
}

function captureMarkDoneState(
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

function captureDelegationState(running: RunningDaemon, home: string, roster: string) {
  return {
    harnessRoster: readFileSync(roster, "utf8"),
    delegatedBaselines: loadDelegatedBaselines(home),
    agentRuns: running.state.listAgentRuns(),
  };
}

function subscribeToTrajectory(
  session: ManagedSession["session"],
  events: Array<Record<string, unknown>>,
): void {
  session.subscribe((event: any) => {
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
    }
  });
}

function waitForAgentEnd(session: ManagedSession["session"], timeoutMs: number): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`timed out after ${timeoutMs}ms waiting for the completion-driven parent turn`));
    }, timeoutMs);
    const unsubscribe = session.subscribe((event: any) => {
      if (event.type === "agent_end") {
        clearTimeout(timer);
        unsubscribe();
        resolvePromise();
      }
    });
  });
}

function readInput(value: string | undefined): TrialInput {
  if (!value) throw new Error("behavioral trial input is required");
  const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as TrialInput;
  if (parsed.version !== 1) throw new Error("unsupported behavioral scenario version");
  if (!parsed.caseId?.trim() || !parsed.parentContext?.trim()) {
    throw new Error("behavioral case id and parent context are required");
  }
  if (parsed.behaviorProfile === "mark-done") {
    if (!parsed.result?.trim() || !parsed.childSessionId?.trim() || !parsed.sentinelSessionId?.trim()) {
      throw new Error("mark-done result and child/sentinel identities are required");
    }
    if (parsed.childSessionId === parsed.sentinelSessionId || typeof parsed.shouldMarkDone !== "boolean") {
      throw new Error("mark-done scenario requires distinct identities and a boolean expectation");
    }
    return parsed;
  }
  if (parsed.behaviorProfile === "delegation-selection") {
    if (!(["natural-first-delegation", "usage-explanation", "approved-default-reuse"] as string[])
      .includes(parsed.behaviorClaim)) {
      throw new Error("unsupported delegation behavior claim");
    }
    if (!parsed.harnessRoster?.trim() || !Array.isArray(parsed.harnessDetails)) {
      throw new Error("delegation scenario requires a harness roster and controlled details");
    }
    return parsed;
  }
  throw new Error("unsupported behavioral profile");
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
