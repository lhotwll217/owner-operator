// Paid, model-driven acceptance for #128. The configured model loads the shipped prompt and skill,
// chooses every tool call itself, and is graded from the resulting trajectory. Controlled tools
// provide facts and provider outcomes; unlike faux-provider integration tests, no calls are scripted.
// Run: OO_RUN_DELEGATION_SELECTION_EVAL=1 npm run test:delegation-selection
import assert from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
  AgentRunHarness,
  AgentRunStatus,
  approveDelegatedBaseline,
  ensureOwnerOperatorWorkspace,
  type AgentRunCreateInput,
  type AgentRunEffort,
  type GatewayApi,
} from "@owner-operator/core";
import { agentRunFixture } from "../../test/fixtures/agent-run";
import { proposeDelegatedBaseline } from "../agent-runs/launch-config";
import { ownerOperatorPiServices, ownerOperatorPrompt } from "./agent";
import { ownerOperatorResourceLoaderOptions } from "./skills";
import { createDelegateAgentTool } from "./tools/delegate-agent";
import { createGetHarnessDetailsTool } from "./tools/get-harness-details";
import { createManageDelegatedBaselineTool } from "./tools/manage-delegated-baseline";

if (process.env.OO_RUN_DELEGATION_SELECTION_EVAL !== "1") {
  process.stdout.write("skip — set OO_RUN_DELEGATION_SELECTION_EVAL=1 to run paid model-driven delegation evals\n");
  process.exit(0);
}

interface Identity { harness: AgentRunHarness; model: string; effort: AgentRunEffort | null }
interface DetailFixture {
  harness: AgentRunHarness;
  models: Array<{ id: string; reasoningLevels: AgentRunEffort[] }> | null;
  allowanceWindows: Array<{ id: string; usedPercent: number }> | null;
}
interface BehaviorCase {
  id: string;
  prompt: string;
  roster: string;
  details: DetailFixture[];
  reject?: { harness: AgentRunHarness; model: string; reason: string };
  expectedLaunches: Identity[];
  bypassSelection?: boolean;
  requiresDetails?: boolean;
  requiresFallbackReport?: boolean;
  requiresOwnerQuestion?: boolean;
  requiresUnknownReport?: boolean;
}

const fixturePath = join(process.cwd(), "src/agent/fixtures/delegation-selection.behavior-cases.json");
const allCases = JSON.parse(readFileSync(fixturePath, "utf8")) as BehaviorCase[];
const selectedIds = new Set((process.env.OO_DELEGATION_SELECTION_CASES ?? "")
  .split(",").map((value) => value.trim()).filter(Boolean));
const cases = selectedIds.size ? allCases.filter((entry) => selectedIds.has(entry.id)) : allCases;
assert.ok(cases.length > 0, "OO_DELEGATION_SELECTION_CASES did not match a fixture id");
const root = mkdtempSync(join(tmpdir(), "oo-delegation-behavior-"));
const { modelRuntime, settingsManager } = await ownerOperatorPiServices();
const originalHome = process.env.HOME;
const originalOoHome = process.env.OO_HOME;

const identity = (input: AgentRunCreateInput): Identity => ({
  harness: input.harness,
  model: input.model ?? "",
  effort: input.effort ?? null,
});
const exact = (actual: Identity, expected: Identity): boolean =>
  actual.harness === expected.harness && actual.model === expected.model && actual.effort === expected.effort;

async function sessionFor(
  id: string,
  roster: string,
  details: DetailFixture[],
  delegate: Pick<GatewayApi, "delegateAgent" | "waitAgentRun">,
  baselineCandidate = { model: "harness-candidate", effort: null as AgentRunEffort | null, availableEfforts: null },
) {
  const userHome = join(root, id, "home");
  const ooHome = join(userHome, ".owner-operator");
  const cwd = join(root, id, "task");
  mkdirSync(cwd, { recursive: true });
  process.env.HOME = userHome;
  process.env.OO_HOME = ooHome;
  const paths = ensureOwnerOperatorWorkspace(ooHome);
  writeFileSync(paths.harnessRoster, `# Harness roster\n\n${roster}`);
  const detailCalls: unknown[] = [];
  const tools = [
    createGetHarnessDetailsTool({ read: async (input) => {
      detailCalls.push(input);
      const selected = input.harnesses?.length
        ? details.filter((entry) => input.harnesses?.includes(entry.harness))
        : details;
      return selected.map((entry) => ({
        harness: entry.harness,
        models: entry.models?.map((model) => ({
          id: model.id,
          displayName: model.id,
          reasoningLevels: model.reasoningLevels,
          defaultReasoningLevel: null,
          isDefault: false,
        })) ?? null,
        allowanceWindows: entry.allowanceWindows?.map((window) => ({
          ...window,
          label: window.id,
          resetsAt: null,
          windowMinutes: null,
        })) ?? null,
        observedAt: "2026-08-12T12:00:00.000Z",
        source: "controlled current harness observation",
        account: null,
        baselineCandidate: null,
        notes: entry.allowanceWindows === null ? ["Allowance usage is unknown."] : [],
        errors: [],
      }));
    }}),
    createManageDelegatedBaselineTool({
      propose: (harness) => proposeDelegatedBaseline(harness, { ooHome, discover: async () => baselineCandidate }),
      approve: (harness, approval) => approveDelegatedBaseline(harness, approval, ooHome),
    }),
    createDelegateAgentTool({ resolveGateway: async () => delegate }),
  ];
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: paths.piAgentDir,
    settingsManager,
    ...ownerOperatorResourceLoaderOptions({ ooHome, personalSkillsRoot: join(root, "no-personal-skills") }),
    systemPromptOverride: ownerOperatorPrompt,
    appendSystemPromptOverride: () => [],
  });
  await loader.reload();
  const sessionManager = SessionManager.inMemory(cwd);
  const { session } = await createAgentSession({
    cwd,
    agentDir: paths.piAgentDir,
    modelRuntime,
    resourceLoader: loader,
    sessionManager,
    settingsManager,
    tools: ["read", "get_harness_details", "manage_delegated_baseline", "delegate_agent"],
    customTools: tools,
  });
  const calls: Array<{ name: string; args: any; error?: boolean }> = [];
  let response = "";
  session.subscribe((event: any) => {
    if (event.type === "tool_execution_start") calls.push({ name: event.toolName, args: event.args });
    if (event.type === "tool_execution_end" && event.isError) {
      const call = [...calls].reverse().find((entry) => entry.name === event.toolName && entry.error === undefined);
      if (call) call.error = true;
    }
    const update = event.assistantMessageEvent;
    if (event.type === "message_update" && update?.type === "text_delta") response += update.delta;
  });
  return { session, calls, detailCalls, paths, takeResponse: () => { const value = response; response = ""; return value; } };
}

try {
  for (const entry of cases) {
    const launches: AgentRunCreateInput[] = [];
    const backend = {
      async delegateAgent(input: AgentRunCreateInput) {
        launches.push(input);
        if (entry.reject && input.harness === entry.reject.harness && input.model === entry.reject.model) {
          throw new Error(entry.reject.reason);
        }
        return agentRunFixture(`${entry.id}-${launches.length}`, AgentRunStatus.Pending, {
          ...input,
          model: input.model ?? null,
          effort: input.effort ?? null,
        });
      },
      async waitAgentRun() { throw new Error("behavior eval must not poll"); },
    } satisfies Pick<GatewayApi, "delegateAgent" | "waitAgentRun">;
    const run = await sessionFor(entry.id, entry.roster, entry.details, backend);
    await run.session.prompt(entry.prompt);
    const response = run.takeResponse();
    const actual = launches.map(identity);
    assert.equal(actual.length, entry.expectedLaunches.length, `${entry.id}: launch count\n${response}`);
    entry.expectedLaunches.forEach((expected, index) => {
      assert.ok(exact(actual[index]!, expected), `${entry.id}: exact launch ${index + 1}: ${JSON.stringify(actual[index])}`);
    });
    const names = run.calls.map(({ name }) => name);
    if (entry.bypassSelection) {
      assert.deepEqual(names, ["delegate_agent"], `${entry.id}: complete explicit identity bypasses the skill`);
    }
    if (entry.requiresDetails) {
      assert.ok(names.includes("read") && names.includes("get_harness_details"), `${entry.id}: consults skill/roster and facts`);
    }
    if (entry.requiresFallbackReport) {
      assert.match(response, /advertis|access|reject|capacity|unavailable|availability/i, `${entry.id}: reports material failure reason`);
      for (const expected of entry.expectedLaunches) {
        assert.ok(response.includes(expected.harness) && response.includes(expected.model),
          `${entry.id}: reports failed and actual identity\n${response}`);
      }
    }
    if (entry.requiresOwnerQuestion) {
      assert.match(response, /\?|choose|please (?:select|approve)|should I|would you/i,
        `${entry.id}: asks rather than silently downgrading`);
      assert.ok(!launches.some((launch) => launch.model === "gpt-fast"), `${entry.id}: rejects quality downgrade`);
    }
    if (entry.requiresUnknownReport) assert.match(response, /unknown|not (?:available|exposed|known)/i);
    assert.equal(readFileSync(run.paths.harnessRoster, "utf8"), `# Harness roster\n\n${entry.roster}`);
    assert.equal(approveCalls(run.calls), 0, `${entry.id}: transient selection never approves a baseline`);
    assert.deepEqual(existsSync(run.paths.delegatedBaselines) ? readdirSync(run.paths.delegatedBaselines) : [], [],
      `${entry.id}: no failure or preference ledger is added`);
    run.session.dispose();
    process.stdout.write(`ok — model-driven ${entry.id}\n`);
  }

  // The approval case is conversational: the model must stop, then persist only after the owner's
  // second turn, retry selection, and explicitly launch the approved nullable identity.
  const launches: AgentRunCreateInput[] = [];
  const candidate = { model: "discovered-real-default", effort: null as AgentRunEffort | null, availableEfforts: null };
  const backend = {
    async delegateAgent(input: AgentRunCreateInput) {
      launches.push(input);
      return agentRunFixture("approved-baseline", AgentRunStatus.Pending, { ...input, model: input.model ?? null, effort: input.effort ?? null });
    },
    async waitAgentRun() { throw new Error("behavior eval must not poll"); },
  } satisfies Pick<GatewayApi, "delegateAgent" | "waitAgentRun">;
  const approval = await sessionFor(
    "missing-baseline-approval",
    "### Quick mechanical work\n_No preference configured._\n",
    [{ harness: AgentRunHarness.ClaudeCode, models: null, allowanceWindows: null }],
    backend,
    candidate,
  );
  await approval.session.prompt("Delegate a quick repository inventory with claude-code. Choose remaining identity details for me.");
  assert.equal(launches.length, 0, "missing baseline: no pre-approval launch");
  assert.equal(approveCalls(approval.calls), 0, "missing baseline: proposal does not mutate baseline");
  assert.match(approval.takeResponse(), /approve|approval/i);
  await approval.session.prompt("I explicitly approve claude-code / discovered-real-default / effort null. Continue.");
  const actual = launches.map(identity);
  assert.deepEqual(actual, [{ harness: AgentRunHarness.ClaudeCode, model: candidate.model, effort: null }]);
  assert.equal(approveCalls(approval.calls), 1, "approval persists exactly once before retry");
  const approveIndex = approval.calls.findIndex((call) => call.name === "manage_delegated_baseline" && call.args.action === "approve");
  const launchIndex = approval.calls.findIndex((call) => call.name === "delegate_agent");
  assert.ok(approveIndex >= 0 && launchIndex > approveIndex, "approved baseline persists before launch");
  approval.session.dispose();
  process.stdout.write("ok — model-driven missing baseline proposes, asks, persists, retries, and preserves effort null\n");
} finally {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalOoHome === undefined) delete process.env.OO_HOME;
  else process.env.OO_HOME = originalOoHome;
  rmSync(root, { recursive: true, force: true });
}

function approveCalls(calls: Array<{ name: string; args: any }>): number {
  return calls.filter((call) => call.name === "manage_delegated_baseline" && call.args.action === "approve").length;
}
