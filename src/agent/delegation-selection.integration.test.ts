import assert from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  ensureOwnerOperatorWorkspace,
  type AgentRunCreateInput,
  type GatewayApi,
} from "@owner-operator/core";
import { agentRunFixture } from "../../test/fixtures/agent-run";
import { ownerOperatorPrompt, repoRoot } from "./agent";
import { ownerOperatorResourceLoaderOptions } from "./skills";
import { createDelegateAgentTool } from "./tools/delegate-agent";
import { createGetHarnessDetailsTool } from "./tools/get-harness-details";

const root = mkdtempSync(join(tmpdir(), "oo-delegation-selection-"));
const ooHome = join(root, "oo-home");
const cwd = join(root, "task");
const agentDir = join(root, "pi");
mkdirSync(cwd, { recursive: true });
mkdirSync(agentDir, { recursive: true });

const paths = ensureOwnerOperatorWorkspace(ooHome);
writeFileSync(paths.harnessRoster, `# Harness roster

## Custom roles

### Migration verification

Use Codex model owner-custom-model with no reasoning effort.
`);

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
    return [{
      harness: AgentRunHarness.Codex,
      observedAt: "2026-08-12T12:00:00.000Z",
      source: "captured test observation",
      account: null,
      models: [{
        id: "owner-custom-model",
        displayName: "Owner custom model",
        reasoningLevels: [],
        defaultReasoningLevel: null,
        isDefault: false,
      }],
      allowanceWindows: null,
      baselineCandidate: null,
      notes: ["Allowance is unknown."],
      errors: [],
    }];
  },
});
const delegateTool = createDelegateAgentTool({ resolveGateway: async () => backend });
const skillPath = join(repoRoot, "src", "agent", "skills", "select-harness-for-delegation", "SKILL.md");

const faux = fauxProvider({ api: "delegation-selection", provider: "delegation-selection", tokensPerSecond: 0 });
faux.setResponses([
  fauxAssistantMessage(fauxToolCall("read", { path: skillPath }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("read", { path: paths.harnessRoster }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("get_harness_details", { harnesses: ["codex"] }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("delegate_agent", {
    harness: "codex",
    model: "owner-custom-model",
    effort: null,
    task: "Verify the account migration directly; do not launch nested or background agents.",
    cwd,
  }), { stopReason: "toolUse" }),
  fauxAssistantMessage("Delegated with codex / owner-custom-model / effort null."),
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
    tools: ["read", "get_harness_details", "delegate_agent"],
    customTools: [detailsTool, delegateTool],
  });
  const calls: Array<{ name: string; args: unknown }> = [];
  const failedCalls: string[] = [];
  session.subscribe((event) => {
    if (event.type === "tool_execution_start") calls.push({ name: event.toolName, args: event.args });
    if (event.type === "tool_execution_end" && event.isError) failedCalls.push(event.toolName);
  });

  await session.prompt("Delegate migration verification. Choose the execution identity for me.");
  assert.deepEqual(calls.map(({ name }) => name), [
    "read",
    "read",
    "get_harness_details",
    "delegate_agent",
  ]);
  assert.deepEqual(failedCalls, [], "the bundled skill and roster are readable through the real session");
  assert.deepEqual(detailsCalls, [{ harnesses: [AgentRunHarness.Codex] }]);
  assert.equal(launches.length, 1);
  assert.deepEqual(launches[0], {
    harness: AgentRunHarness.Codex,
    model: "owner-custom-model",
    effort: null,
    task: "Verify the account migration directly; do not launch nested or background agents.",
    cwd,
    parentThreadId: sessionManager.getSessionId(),
  });
  const last = session.state.messages.at(-1);
  assert.equal(last?.role, "assistant");
  assert.match(JSON.stringify(last), /codex \/ owner-custom-model \/ effort null/);

  const implicitCallCount = calls.length;
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("delegate_agent", {
      harness: "claude-code",
      model: "owner-explicit-model",
      effort: "high",
      task: "Review the release notes directly; do not launch nested or background agents.",
      cwd,
    }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Delegated with claude-code / owner-explicit-model / effort high."),
  ]);
  await session.prompt(
    "Delegate the release-note review with harness claude-code, model owner-explicit-model, and effort high.",
  );
  assert.deepEqual(
    calls.slice(implicitCallCount).map(({ name }) => name),
    ["delegate_agent"],
    "a complete explicit owner selection bypasses skill, roster, and harness-detail lookup",
  );
  assert.deepEqual(launches[1], {
    harness: AgentRunHarness.ClaudeCode,
    model: "owner-explicit-model",
    effort: "high",
    task: "Review the release notes directly; do not launch nested or background agents.",
    cwd,
    parentThreadId: sessionManager.getSessionId(),
  });
  session.dispose();
  process.stdout.write("ok — implicit delegation loads policy and roster, observes facts, and forwards an exact custom-role identity\n");
} finally {
  rmSync(root, { recursive: true, force: true });
}
