// Owner Operator — pi's stock interactive mode, wired to our agent config. This is the
// default terminal surface; the widget owns the always-visible session list.
//
//   ./oo    (bare — this is the default surface)
//
// Built by mirroring pi's own main.ts runtime wiring — createAgentSessionServices →
// createAgentSessionFromServices → createAgentSessionRuntime → new InteractiveMode(runtime).run()
// — but feeding it our services (prompt override + custom tools).

import {
  AuthStorage,
  SettingsManager,
  getAgentDir,
  createAgentSessionServices,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  InteractiveMode,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import { createOoSession, ooProvenance, ownerOperatorPrompt, ownerOperatorCustomTools, ownerOperatorTools, repoRoot } from "../agent/agent";
import { blacklistAwareFileToolsExtension } from "../agent/privacy-tools";

if (!process.stdout.isTTY) {
  console.error("Owner Operator interactive mode needs an interactive terminal.\nUse `./oo` in a real terminal, or `./oo \"question\"` for a headless single turn.");
  process.exit(1);
}

const prompt = ownerOperatorPrompt();
const authStorage = AuthStorage.create();

// The runtime factory pi reuses for /new, /resume, /fork — rebuild OUR services + session for
// whatever cwd it hands us (always repoRoot here) so those flows keep our prompt and tools.
const createRuntime: Parameters<typeof createAgentSessionRuntime>[0] = async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
  const services = await createAgentSessionServices({
    cwd,
    agentDir,
    authStorage,
    settingsManager: SettingsManager.create(cwd), // model from .pi/settings.json (codex gpt-5.5)
    resourceLoaderOptions: {
      systemPromptOverride: () => prompt,          // our owner-operator prompt, verbatim
      appendSystemPromptOverride: () => [],
      extensionFactories: [
        blacklistAwareFileToolsExtension,           // same-name read/grep/find/ls privacy overrides
      ],
    },
  });
  const created = await createAgentSessionFromServices({
    services,
    sessionManager,
    sessionStartEvent,
    tools: ownerOperatorTools,
    customTools: ownerOperatorCustomTools,
  });
  return { ...created, services, diagnostics: services.diagnostics };
};

const runtime = await createAgentSessionRuntime(createRuntime, {
  cwd: repoRoot,
  agentDir: getAgentDir(),
  sessionManager: createOoSession(ooProvenance("interactive")), // saved + labeled like every oo surface
});

initTheme(runtime.services.settingsManager.getTheme(), true);

const interactive = new InteractiveMode(runtime, {
  initialMessage: "What's ongoing today? Read get_current_session_state for the authoritative row set, call scan_active_transcripts for message samples, then answer concisely with every active row, merged with anything new the scan found, most-urgent first.",
});
await interactive.run();
