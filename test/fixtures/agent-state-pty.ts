import { appendFileSync } from "node:fs";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  initTheme,
  InteractiveMode,
} from "@earendil-works/pi-coding-agent";
import {
  AgentRunStatus,
  type GatewayApi,
} from "@owner-operator/core";
import {
  createOoSession,
  ooProvenance,
  ownerOperatorPiServices,
  ownerOperatorPrompt,
} from "../../src/agent/agent";
import { createAgentStateExtension } from "../../src/agent-runs/agent-state-extension";
import { agentRunFixture } from "./agent-run";

const actionFile = process.env.OO_TEST_ACTION_FILE;
if (!actionFile) throw new Error("OO_TEST_ACTION_FILE is required");

const sessionManager = createOoSession(ooProvenance("interactive"));
let rows = [agentRunFixture("running", AgentRunStatus.Running, {
  parentThreadId: sessionManager.getSessionId(),
  task: "Review reconnect behavior",
  activity: "Waiting for durable terminal truth",
})];
const gateway = {
  listAgentRuns: async () => rows,
  subscribe: () => () => undefined,
  cancelAgentRun: async (id: string) => {
    appendFileSync(actionFile, `cancel:${id}\n`);
    const cancelled = agentRunFixture(id, AgentRunStatus.Cancelled, {
      parentThreadId: sessionManager.getSessionId(),
    });
    rows = [cancelled];
    return cancelled;
  },
  resumeAgentRun: async (id: string) => agentRunFixture(`${id}-resumed`, AgentRunStatus.Pending, {
    parentThreadId: sessionManager.getSessionId(),
  }),
} as Pick<GatewayApi, "listAgentRuns" | "subscribe" | "cancelAgentRun" | "resumeAgentRun">;

const { authStorage, paths } = ownerOperatorPiServices();
const prompt = ownerOperatorPrompt();
const createRuntime: Parameters<typeof createAgentSessionRuntime>[0] = async ({ cwd, sessionManager, sessionStartEvent }) => {
  const { settingsManager } = ownerOperatorPiServices(paths.home);
  const services = await createAgentSessionServices({
    cwd,
    agentDir: paths.piAgentDir,
    authStorage,
    settingsManager,
    resourceLoaderOptions: {
      systemPromptOverride: () => prompt,
      appendSystemPromptOverride: () => [],
      extensionFactories: [{
        name: "owner-operator-agent-state",
        factory: createAgentStateExtension({ resolveGateway: async () => gateway as GatewayApi }),
      }],
    },
  });
  const created = await createAgentSessionFromServices({
    services,
    sessionManager,
    sessionStartEvent,
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
