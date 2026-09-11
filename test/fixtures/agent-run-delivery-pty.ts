import { appendFileSync } from "node:fs";
import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  initTheme,
  InteractiveMode,
} from "@earendil-works/pi-coding-agent";
import {
  AgentRunStatus,
  GatewayEventKind,
  type GatewayApi,
} from "@owner-operator/core";
import {
  createOoSession,
  ooProvenance,
  ownerOperatorPiServices,
  ownerOperatorPrompt,
} from "../../src/agent/agent";
import { createInteractiveAgentRunDeliveryExtension } from "../../src/agent-runs/agent-run-delivery-extension";
import { agentRunFixture } from "./agent-run";

const actionFile = process.env.OO_TEST_ACTION_FILE;
if (!actionFile) throw new Error("OO_TEST_ACTION_FILE is required");
assert.equal(process.stdout.columns, 40);

const sessionManager = createOoSession(ooProvenance("interactive"));
const faux = fauxProvider({ api: "oo-pty-completion", provider: "oo-pty-completion", tokensPerSecond: 0 });
faux.setResponses([(context) => {
  assert.match(JSON.stringify(context.messages), /agent-run-completion:running/);
  return fauxAssistantMessage("Completion received by parent.");
}]);
let invalidate: (() => void) | undefined;
let rows = [agentRunFixture("running", AgentRunStatus.Running, {
  parentThreadId: sessionManager.getSessionId(),
  task: "Review reconnect behavior",
  activity: "Waiting for durable terminal truth",
})];
const gateway = {
  listAgentRuns: async () => rows,
  subscribe: (listener: (event: { kind: GatewayEventKind }) => void) => {
    invalidate = () => listener({ kind: GatewayEventKind.AgentRunChanged });
    return () => { invalidate = undefined; };
  },
} satisfies Pick<GatewayApi, "listAgentRuns" | "subscribe">;

const { modelRuntime, paths } = await ownerOperatorPiServices();
const prompt = ownerOperatorPrompt();
const createRuntime: Parameters<typeof createAgentSessionRuntime>[0] = async ({ cwd, sessionManager, sessionStartEvent }) => {
  const { settingsManager } = await ownerOperatorPiServices(paths.home);
  const services = await createAgentSessionServices({
    cwd,
    agentDir: paths.piAgentDir,
    modelRuntime,
    settingsManager,
    resourceLoaderOptions: {
      systemPromptOverride: () => prompt,
      appendSystemPromptOverride: () => [],
      extensionFactories: [
        {
          name: "owner-operator-agent-run-delivery",
          factory: createInteractiveAgentRunDeliveryExtension({ resolveGateway: async () => gateway as GatewayApi }),
        },
        {
          name: "pty-test-control",
          factory: (pi) => {
            pi.on("session_start", (_event, ctx) => { ctx.ui.notify("Fixture ready", "info"); });
            const model = faux.getModel();
            pi.registerProvider(faux.provider.id, {
              baseUrl: model.baseUrl,
              apiKey: "test-only",
              api: faux.api as any,
              models: [{
                id: model.id, name: model.name, reasoning: model.reasoning, input: model.input,
                cost: model.cost, contextWindow: model.contextWindow, maxTokens: model.maxTokens,
              }],
              streamSimple: faux.provider.streamSimple.bind(faux.provider),
            });
            pi.registerCommand("test-complete", {
              description: "Complete the fixture child",
              handler: async () => {
                assert.ok(!pi.getCommands().some(({ name }) => name === "agent-state"));
                rows = [agentRunFixture("running", AgentRunStatus.Completed, {
                  parentThreadId: sessionManager.getSessionId(),
                  task: "Review reconnect behavior",
                  resultTail: "Reconnect review complete",
                })];
                invalidate!();
                appendFileSync(actionFile, "completed-without-agent-state-command\n");
              },
            });
          },
        },
      ],
    },
  });
  const created = await createAgentSessionFromServices({
    services,
    sessionManager,
    sessionStartEvent,
    model: faux.getModel(),
    tools: [],
    customTools: [],
  });
  return { ...created, services, diagnostics: services.diagnostics };
};

const runtime = await createAgentSessionRuntime(createRuntime, {
  cwd: process.cwd(),
  agentDir: paths.piAgentDir,
  sessionManager,
});
initTheme(runtime.services.settingsManager.getTheme(), true);
await new InteractiveMode(runtime).run();
