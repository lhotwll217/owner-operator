import assert from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
  AgentRunHarness,
  AgentRunStatus,
  approveDelegatedBaseline,
  ensureOwnerOperatorWorkspace,
  loadDelegatedBaseline,
  type AgentRunCreateInput,
  type GatewayApi,
} from "@owner-operator/core";
import { agentRunFixture } from "../../test/fixtures/agent-run";
import { proposeDelegatedBaseline } from "../agent-runs/launch-config";
import { ownerOperatorPrompt, repoRoot } from "./agent";
import { ownerOperatorResourceLoaderOptions } from "./skills";
import { createDelegateAgentTool } from "./tools/delegate-agent";
import { createGetHarnessDetailsTool } from "./tools/get-harness-details";
import { createManageDelegatedBaselineTool } from "./tools/manage-delegated-baseline";

const root = mkdtempSync(join(tmpdir(), "oo-delegation-selection-"));
const ooHome = join(root, "oo-home");
const cwd = join(root, "task");
const agentDir = join(root, "pi");
mkdirSync(cwd, { recursive: true });
mkdirSync(agentDir, { recursive: true });

const paths = ensureOwnerOperatorWorkspace(ooHome);
const roster = `# Harness roster

## Custom roles

### Migration verification

Use Codex model owner-custom-model with no reasoning effort.
`;
writeFileSync(paths.harnessRoster, roster);

const launches: AgentRunCreateInput[] = [];
const backend = {
  async delegateAgent(input: AgentRunCreateInput) {
    launches.push(input);
    return agentRunFixture("implicit-run", AgentRunStatus.Pending, {
      ...input,
      parentThreadId: input.parentThreadId ?? null,
      model: input.model ?? null,
      effort: input.effort ?? null,
    });
  },
  async waitAgentRun() { throw new Error("wait not expected"); },
} as Pick<GatewayApi, "delegateAgent" | "waitAgentRun">;

const detailsCalls: unknown[] = [];
const detailsTool = createGetHarnessDetailsTool({
  read: async (input) => {
    detailsCalls.push(input);
    assert.ok(input.harnesses?.[0]);
    return [{
      harness: input.harnesses[0],
      observedAt: "2026-08-12T12:00:00.000Z",
      source: "captured test observation",
      account: null,
      models: null,
      allowanceWindows: null,
      baselineCandidate: null,
      notes: ["Account, catalog, and allowance are unknown."],
      errors: [],
    }];
  },
});
const delegateTool = createDelegateAgentTool({ resolveGateway: async () => backend });
const baselineCandidate = { model: "harness-observed-model", effort: null, availableEfforts: null };
const manageTool = createManageDelegatedBaselineTool({
  propose: (harness) => proposeDelegatedBaseline(harness, {
    ooHome,
    discover: async () => baselineCandidate,
  }),
  approve: (harness, approval) => approveDelegatedBaseline(harness, approval, ooHome),
});
const skillPath = join(repoRoot, "src", "agent", "skills", "select-harness-for-delegation", "SKILL.md");
const baselinePath = join(paths.delegatedBaselines, `${AgentRunHarness.ClaudeCode}.json`);

const faux = fauxProvider({ api: "delegation-selection", provider: "delegation-selection", tokensPerSecond: 0 });
faux.setResponses([
  fauxAssistantMessage(fauxToolCall("delegate_agent", {
    harness: "codex",
    model: "owner-explicit-model",
    effort: null,
    task: "Review the release notes directly; do not launch nested or background agents.",
    cwd,
  }), { stopReason: "toolUse" }),
  fauxAssistantMessage("Delegated with codex / owner-explicit-model / effort null."),
]);

try {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("delegation-selection", async () => ({ type: "api_key", key: "test-only" }));
  const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null });
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    ...ownerOperatorResourceLoaderOptions({ ooHome, personalSkillsRoot: join(root, "personal-skills") }),
    systemPromptOverride: ownerOperatorPrompt,
    appendSystemPromptOverride: () => [],
    extensionFactories: [{
      name: "delegation-selection-faux",
      factory: (pi) => {
        const model = faux.getModel();
        pi.registerProvider("delegation-selection", {
          baseUrl: model.baseUrl,
          apiKey: "test-only",
          api: faux.api as any,
          models: [{
            id: model.id,
            name: model.name,
            reasoning: model.reasoning,
            input: model.input,
            cost: model.cost,
            contextWindow: model.contextWindow,
            maxTokens: model.maxTokens,
          }],
          streamSimple: faux.provider.streamSimple.bind(faux.provider),
        });
      },
    }],
  });
  await loader.reload();
  const sessionManager = SessionManager.inMemory(cwd);
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    model: faux.getModel(),
    resourceLoader: loader,
    sessionManager,
    settingsManager,
    tools: ["read", "get_harness_details", "manage_delegated_baseline", "delegate_agent"],
    customTools: [detailsTool, manageTool, delegateTool],
  });
  const calls: Array<{ name: string; args: unknown }> = [];
  const failedCalls: string[] = [];
  session.subscribe((event) => {
    if (event.type === "tool_execution_start") calls.push({ name: event.toolName, args: event.args });
    if (event.type === "tool_execution_end" && event.isError) failedCalls.push(event.toolName);
  });

  await session.prompt(
    "Delegate the release-note review with harness codex, model owner-explicit-model, and effort null.",
  );
  assert.deepEqual(calls.map(({ name }) => name), ["delegate_agent"],
    "a complete explicit owner selection bypasses selection, details, and baseline management");
  assert.deepEqual(launches[0], {
    harness: AgentRunHarness.Codex,
    model: "owner-explicit-model",
    effort: null,
    task: "Review the release notes directly; do not launch nested or background agents.",
    cwd,
    parentThreadId: sessionManager.getSessionId(),
  });
  assert.deepEqual(detailsCalls, []);

  const beforeProposal = calls.length;
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("read", { path: skillPath }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("read", { path: paths.harnessRoster }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("get_harness_details", { harnesses: ["claude-code"] }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("manage_delegated_baseline", {
      action: "propose",
      harness: "claude-code",
    }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Please approve claude-code / harness-observed-model / effort null before I launch."),
  ]);
  await session.prompt("Delegate a routine repository inventory. Choose the execution identity for me.");
  assert.deepEqual(calls.slice(beforeProposal).map(({ name }) => name), [
    "read",
    "read",
    "get_harness_details",
    "manage_delegated_baseline",
  ]);
  assert.equal(launches.length, 1, "no implicit launch occurs before owner approval");
  assert.equal(existsSync(baselinePath), false, "proposing a baseline does not persist it");
  assert.equal(readFileSync(paths.harnessRoster, "utf8"), roster, "selection never edits the owner roster");

  const beforeApproval = calls.length;
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("manage_delegated_baseline", {
      action: "approve",
      harness: "claude-code",
      model: baselineCandidate.model,
      effort: null,
    }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("read", { path: paths.harnessRoster }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("get_harness_details", { harnesses: ["claude-code"] }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("manage_delegated_baseline", {
      action: "propose",
      harness: "claude-code",
    }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("delegate_agent", {
      harness: "claude-code",
      model: baselineCandidate.model,
      effort: null,
      task: "Inventory the repository directly; do not launch nested or background agents.",
      cwd,
    }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Delegated with claude-code / harness-observed-model / effort null."),
  ]);
  await session.prompt("I approve exactly claude-code / harness-observed-model / effort null.");
  assert.deepEqual(calls.slice(beforeApproval).map(({ name }) => name), [
    "manage_delegated_baseline",
    "read",
    "get_harness_details",
    "manage_delegated_baseline",
    "delegate_agent",
  ], "approval persists before selection retries and launches");
  assert.deepEqual(loadDelegatedBaseline(AgentRunHarness.ClaudeCode, ooHome), {
    model: baselineCandidate.model,
    effort: null,
    approvedAt: JSON.parse(readFileSync(baselinePath, "utf8")).approvedAt,
  });
  assert.equal(readFileSync(paths.harnessRoster, "utf8"), roster, "baseline approval leaves the roster unchanged");
  assert.deepEqual(detailsCalls, [
    { harnesses: [AgentRunHarness.ClaudeCode] },
    { harnesses: [AgentRunHarness.ClaudeCode] },
  ], "unknown harness observations are consulted again without blocking an approved baseline");
  assert.deepEqual(launches[1], {
    harness: AgentRunHarness.ClaudeCode,
    model: baselineCandidate.model,
    effort: null,
    task: "Inventory the repository directly; do not launch nested or background agents.",
    cwd,
    parentThreadId: sessionManager.getSessionId(),
  });
  assert.deepEqual(failedCalls, [], "the real management and delegation tools complete successfully");
  session.dispose();
  process.stdout.write("ok — delegation selection preserves explicit nulls, approval boundaries, and unknown observations\n");
} finally {
  rmSync(root, { recursive: true, force: true });
}
