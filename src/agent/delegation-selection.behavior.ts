// Paid, model-driven acceptance for #128. The configured model loads the shipped prompt and skill,
// chooses every tool call itself, and is graded from the resulting trajectory. Controlled tools
// provide facts and provider outcomes; unlike faux-provider integration tests, no calls are scripted.
// Run: OO_RUN_DELEGATION_SELECTION_EVAL=1 npm run test:delegation-selection
import assert from "node:assert";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
import { lastAssistantError, ownerOperatorPiServices, ownerOperatorPrompt } from "./agent";
import {
  parseDelegationBehaviorFixtures,
  type DelegationDetailFixture,
  type DelegationFixtureIdentity,
} from "./delegation-selection-fixtures";
import { requiredReasonTerms } from "./delegation-selection-grading";
import { ownerOperatorResourceLoaderOptions } from "./skills";
import { createDelegateAgentTool } from "./tools/delegate-agent";
import { createGetHarnessDetailsTool } from "./tools/get-harness-details";
import { createManageDelegatedBaselineTool } from "./tools/manage-delegated-baseline";

if (process.env.OO_RUN_DELEGATION_SELECTION_EVAL !== "1") {
  process.stdout.write("skip — set OO_RUN_DELEGATION_SELECTION_EVAL=1 to run paid model-driven delegation evals\n");
  process.exit(0);
}

const fixturePath = join(process.cwd(), "src/agent/fixtures/delegation-selection.behavior-cases.json");
const allCases = parseDelegationBehaviorFixtures(readFileSync(fixturePath, "utf8"));
const selectedIds = new Set((process.env.OO_DELEGATION_SELECTION_CASES ?? "")
  .split(",").map((value) => value.trim()).filter(Boolean));
const cases = selectedIds.size ? allCases.filter((entry) => selectedIds.has(entry.id)) : allCases;
assert.ok(cases.length > 0, "OO_DELEGATION_SELECTION_CASES did not match a fixture id");
const originalHome = process.env.HOME;
const originalOoHome = process.env.OO_HOME;
const root = mkdtempSync(join(tmpdir(), "oo-delegation-behavior-"));
const evalHome = join(root, "home");
const evalOoHome = join(evalHome, ".owner-operator");
process.env.HOME = evalHome;
process.env.OO_HOME = evalOoHome;
const evalPaths = ensureOwnerOperatorWorkspace(evalOoHome);
const authPath = process.env.OO_DELEGATION_SELECTION_AUTH_PATH?.trim();
assert.ok(authPath, "set OO_DELEGATION_SELECTION_AUTH_PATH to the explicit Pi auth.json used by this paid eval");
copyFileSync(authPath, evalPaths.piAuth);
const settingsPath = process.env.OO_DELEGATION_SELECTION_SETTINGS_PATH?.trim();
if (settingsPath) copyFileSync(settingsPath, evalPaths.piSettings);
const { modelRuntime, settingsManager } = await ownerOperatorPiServices(evalOoHome);
const selectionSkillPath = join(process.cwd(), "src/agent/skills/select-harness-for-delegation/SKILL.md");

const identity = (input: AgentRunCreateInput): DelegationFixtureIdentity => ({
  harness: input.harness,
  model: input.model ?? "",
  effort: input.effort ?? null,
});
const exact = (actual: DelegationFixtureIdentity, expected: DelegationFixtureIdentity): boolean =>
  actual.harness === expected.harness && actual.model === expected.model && actual.effort === expected.effort;

async function sessionFor(
  id: string,
  roster: string,
  details: DelegationDetailFixture[],
  delegate: Pick<GatewayApi, "delegateAgent" | "waitAgentRun">,
  baselineCandidate = { model: "harness-candidate", effort: null as AgentRunEffort | null, availableEfforts: null },
) {
  const userHome = evalHome;
  const ooHome = evalOoHome;
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
          unsupportedReasoningLevels: [],
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
  assert.ok(loader.getSkills().skills.some((skill) => skill.name === "select-harness-for-delegation"),
    `${id}: shipped selection skill is exposed`);
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
    assert.equal(actual.length, entry.expectedLaunches.length,
      `${entry.id}: launch count; model error: ${lastAssistantError(run.session) ?? "none"}\n${response}`);
    entry.expectedLaunches.forEach((expected, index) => {
      assert.ok(exact(actual[index]!, expected), `${entry.id}: exact launch ${index + 1}: ${JSON.stringify(actual[index])}`);
    });
    const names = run.calls.map(({ name }) => name);
    if (entry.bypassSelection) {
      assert.deepEqual(names, ["delegate_agent"], `${entry.id}: complete explicit identity bypasses the skill`);
    }
    if (entry.requiresDetails) {
      const firstLaunch = run.calls.findIndex((call) => call.name === "delegate_agent");
      const skillRead = run.calls.findIndex((call) => call.name === "read" && call.args.path === selectionSkillPath);
      const rosterRead = run.calls.findIndex((call) => call.name === "read" && call.args.path === run.paths.harnessRoster);
      const detailsRead = run.calls.findIndex((call) => call.name === "get_harness_details");
      assert.ok(firstLaunch >= 0, `${entry.id}: implicit selection delegates`);
      assert.ok(skillRead >= 0 && skillRead < firstLaunch, `${entry.id}: reads shipped skill before first delegation`);
      assert.ok(rosterRead >= 0 && rosterRead < firstLaunch, `${entry.id}: reads isolated roster before first delegation`);
      assert.ok(detailsRead >= 0 && detailsRead < firstLaunch, `${entry.id}: reads current harness facts before first delegation`);
    }
    if (entry.requiresFallbackReport) {
      assert.ok(entry.reject, `${entry.id}: fallback fixture defines a rejection`);
      assertReportedIdentity(response, entry.expectedLaunches[0]!, `${entry.id}: reports exact failed identity`);
      assertReportedIdentity(response, entry.expectedLaunches[1]!, `${entry.id}: reports exact replacement identity`);
      const reasonTerms = requiredReasonTerms(entry.reject.reason);
      assert.ok(reasonTerms.every((term) => response.toLowerCase().includes(term)),
        `${entry.id}: reports actual fixture rejection semantics: ${reasonTerms.join(", ")}\n${response}`);
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
      assert.equal(existsSync(baselinePath), true, "approved baseline is durable before delegation is attempted");
      launches.push(input);
      return agentRunFixture("approved-baseline", AgentRunStatus.Pending, { ...input, model: input.model ?? null, effort: input.effort ?? null });
    },
    async waitAgentRun() { throw new Error("behavior eval must not poll"); },
  } satisfies Pick<GatewayApi, "delegateAgent" | "waitAgentRun">;
  const baselinePath = join(evalOoHome, "delegated-baselines", `${AgentRunHarness.ClaudeCode}.json`);
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
  assert.equal(baselinePath, join(approval.paths.delegatedBaselines, `${AgentRunHarness.ClaudeCode}.json`));
  assert.equal(existsSync(baselinePath), false, "missing baseline: no baseline file exists before approval");
  assert.match(approval.takeResponse(), /approve|approval/i);
  await approval.session.prompt("I explicitly approve claude-code / discovered-real-default / effort null. Continue.");
  const actual = launches.map(identity);
  assert.deepEqual(actual, [{ harness: AgentRunHarness.ClaudeCode, model: candidate.model, effort: null }]);
  assert.equal(approveCalls(approval.calls), 1, "approval persists exactly once before retry");
  const approveCall = approval.calls.find((call) => call.name === "manage_delegated_baseline" && call.args.action === "approve");
  assert.deepEqual(approveCall?.args, {
    action: "approve",
    harness: AgentRunHarness.ClaudeCode,
    model: candidate.model,
    effort: null,
  }, "approval persists the exact owner-approved nullable identity");
  const saved = JSON.parse(readFileSync(baselinePath, "utf8"));
  assert.ok(typeof saved.approvedAt === "string", "saved baseline records approval time");
  assert.deepEqual(saved, { model: candidate.model, effort: null, approvedAt: saved.approvedAt },
    "saved baseline is exactly the approved model, explicit null effort, and approval time");
  const approveIndex = approval.calls.findIndex((call) => call.name === "manage_delegated_baseline" && call.args.action === "approve");
  const proposeIndex = approval.calls.findIndex((call) => call.name === "manage_delegated_baseline" && call.args.action === "propose");
  const launchIndex = approval.calls.findIndex((call) => call.name === "delegate_agent");
  const retryIndex = approval.calls.findIndex((call, index) => index > approveIndex && call.name === "get_harness_details");
  assert.ok(proposeIndex >= 0 && approveIndex > proposeIndex, "proposal precedes owner-approved persistence");
  assert.ok(launchIndex > approveIndex, "approved baseline persists before delegation");
  if (retryIndex >= 0) assert.ok(launchIndex > retryIndex, "post-approval selection retry precedes delegation");
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

function assertReportedIdentity(response: string, expected: DelegationFixtureIdentity, message: string): void {
  const escaped = [expected.harness, expected.model, expected.effort === null ? "null" : expected.effort]
    .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  assert.match(response, new RegExp(`${escaped[0]}\\s*(?:/|,|—|-)\\s*${escaped[1]}\\s*(?:/|,|—|-)\\s*(?:effort\\s*)?${escaped[2]}`, "i"), message);
}
