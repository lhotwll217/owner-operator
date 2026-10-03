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
  ensureOwnerOperatorWorkspace,
  loadDelegatedBaseline,
  type HarnessDetailsRequest,
} from "@owner-operator/core";
import { proposeDelegatedBaseline } from "../agent-runs/launch-config";
import { startDaemon } from "../daemon/runtime";
import { ownerOperatorPrompt, repoRoot } from "./agent";
import { ownerOperatorResourceLoaderOptions } from "./skills";

const root = mkdtempSync(join(tmpdir(), "oo-delegation-selection-"));
const ooHome = join(root, "oo-home");
const cwd = join(root, "task");
const agentDir = join(root, "pi");
mkdirSync(cwd, { recursive: true });
mkdirSync(agentDir, { recursive: true });

const paths = ensureOwnerOperatorWorkspace(ooHome);
const preferences = `# User harness preferences

## Custom roles

### Migration verification

Use Codex model owner-custom-model with no reasoning effort.
`;
writeFileSync(paths.userHarnessPreferences, preferences);

// The Operator's bash reaches the daemon through `oo` (adr/0001-agent-uses-its-own-cli.md); this
// process hosts that daemon with only the external harness observations controlled.
const priorEnv = { ...process.env };
process.env.OO_HOME = ooHome;
process.env.OO_AGENT = "1";
process.env.PATH = `${repoRoot}:${process.env.PATH}`;
const detailsCalls: HarnessDetailsRequest[] = [];
const baselineCandidate = { model: "harness-observed-model", effort: null, availableEfforts: null };
const daemon = await startDaemon({
  port: 0,
  watch: false,
  enableEnrichment: false,
  monitor: { scan: async () => [], intervalMs: 60_000 },
  scheduler: { tickMs: 60_000 },
  harness: {
    details: async (input) => {
      detailsCalls.push(input);
      assert.ok(input.harnesses?.[0]);
      return {
        observedAt: "2026-08-12T12:00:00.000Z",
        ephemeral: true,
        preferences: {
          path: paths.userHarnessPreferences,
          content: preferences,
          error: null,
        },
        capabilities: {
          registry: { acpxVersion: "0.13.1", registeredAgentNames: ["codex"] },
          harnesses: [],
        },
        account: [],
        unknowns: [],
      };
    },
    propose: (harness) => proposeDelegatedBaseline(harness, { discover: async () => baselineCandidate }),
  },
});
const DETAILS = "oo harness details --harness claude-code --json";
const PROPOSE = "oo harness propose claude-code --json";
const APPROVE = `oo harness approve claude-code --model ${baselineCandidate.model} --effort none`;
const skillPath = join(repoRoot, "src", "agent", "skills", "select-harness-for-delegation", "SKILL.md");
const baselinePath = join(paths.delegatedBaselines, `${AgentRunHarness.ClaudeCode}.json`);

const faux = fauxProvider({ api: "delegation-selection", provider: "delegation-selection", tokensPerSecond: 0 });
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
    tools: ["read", "bash"],
  });
  const calls: Array<{ name: string; args: { command?: string } }> = [];
  const failedCalls: string[] = [];
  session.subscribe((event) => {
    if (event.type === "tool_execution_start") calls.push({ name: event.toolName, args: event.args });
    if (event.type === "tool_execution_end" && event.isError) failedCalls.push(event.toolName);
  });

  const beforeProposal = calls.length;
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("read", { path: skillPath }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("bash", { command: DETAILS }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("bash", { command: PROPOSE }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Please approve claude-code / harness-observed-model / effort null before I launch."),
  ]);
  await session.prompt("Delegate a routine repository inventory. Choose the execution identity for me.");
  assert.deepEqual(calls.slice(beforeProposal).map(({ name, args }) => args.command ?? name), [
    "read",
    DETAILS,
    PROPOSE,
  ]);
  assert.equal(existsSync(baselinePath), false, "proposing a baseline does not persist it");
  assert.equal(readFileSync(paths.userHarnessPreferences, "utf8"), preferences, "selection never edits owner preferences");

  const beforeApproval = calls.length;
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("bash", { command: APPROVE }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("bash", { command: DETAILS }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("bash", { command: PROPOSE }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Approved claude-code / harness-observed-model / effort null."),
  ]);
  await session.prompt("I approve exactly claude-code / harness-observed-model / effort null.");
  assert.deepEqual(calls.slice(beforeApproval).map(({ args }) => args.command), [
    APPROVE,
    DETAILS,
    PROPOSE,
  ], "approval persists before selection retries");
  assert.deepEqual(loadDelegatedBaseline(AgentRunHarness.ClaudeCode, ooHome), {
    model: baselineCandidate.model,
    effort: null,
    approvedAt: JSON.parse(readFileSync(baselinePath, "utf8")).approvedAt,
  });
  assert.equal(readFileSync(paths.userHarnessPreferences, "utf8"), preferences, "baseline approval leaves preferences unchanged");
  assert.deepEqual(detailsCalls, [
    { harnesses: [AgentRunHarness.ClaudeCode] },
    { harnesses: [AgentRunHarness.ClaudeCode] },
  ], "unknown harness observations are consulted again without blocking an approved baseline");
  assert.deepEqual(failedCalls, [], "the real oo verbs complete successfully");
  session.dispose();
  process.stdout.write("ok — delegation selection preserves approval boundaries and unknown observations\n");
} finally {
  await daemon.close();
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, priorEnv);
  rmSync(root, { recursive: true, force: true });
}
