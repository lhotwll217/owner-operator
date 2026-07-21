// Owner Operator — Pi's interactive mode, wired to Owner Operator-owned config. This is the
// default terminal surface; the widget owns the always-visible session list.
//
//   ./oo    (bare — this is the default surface)
//
// Built by mirroring pi's own main.ts runtime wiring — createAgentSessionServices →
// createAgentSessionFromServices → createAgentSessionRuntime → new InteractiveMode(runtime).run()
// — but feeding it our services (prompt override + custom tools).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createAgentSessionServices,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  getAgentDir,
  InteractiveMode,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import { getCapabilities } from "@earendil-works/pi-tui";
import {
  createOoSession,
  configuredOwnerOperatorTools,
  ooProvenance,
  ownerOperatorCustomTools,
  ownerOperatorPiServices,
  ownerOperatorPrompt,
  repoRoot,
} from "../agent/agent";
import { blacklistAwareFileToolsExtension } from "../agent/privacy-tools";
import {
  configurePermissionSystemEnvironment,
  createPermissionSettingsExtension,
  permissionSystemExtensionPath,
} from "../agent/permission-settings";
import { createOnboardingExtension } from "../agent/onboarding";
import { ownerOperatorResourceLoaderOptions } from "../agent/skills";
import { agentStateExtension } from "../agent-runs/agent-state-extension";
import { buildOoTheme, ooInteractiveOptions, ooMarker, ooPresentationExtension, quietOoInteractiveMode } from "../shared/oo-presentation";

if (!process.stdout.isTTY) {
  console.error("Owner Operator interactive mode needs an interactive terminal.\nUse `./oo` in a real terminal, or `./oo \"question\"` for a headless single turn.");
  process.exit(1);
}

const prompt = ownerOperatorPrompt();
// Permission-system initialization points Pi at OO_HOME. Preserve standalone Pi discovery inputs
// first so onboarding never offers Owner Operator's own sessions as an external transcript source.
const standalonePiEnvironment = { ...process.env };
const standalonePiAgentDir = getAgentDir();
const { authStorage, paths } = ownerOperatorPiServices();
configurePermissionSystemEnvironment(paths);
const interactiveTools = configuredOwnerOperatorTools(paths.home);

// The runtime factory pi reuses for /new, /resume, /fork — rebuild OUR services + session for
// whatever task cwd it hands us so those flows keep our prompt and tools without ambient Pi state.
const createRuntime: Parameters<typeof createAgentSessionRuntime>[0] = async ({ cwd, sessionManager, sessionStartEvent }) => {
  const { settingsManager } = ownerOperatorPiServices(paths.home);
  let refreshRegistry = (): void => undefined;
  const services = await createAgentSessionServices({
    cwd,
    agentDir: paths.piAgentDir,
    authStorage,
    settingsManager,
    resourceLoaderOptions: {
      ...ownerOperatorResourceLoaderOptions(),
      systemPromptOverride: () => prompt,          // our owner-operator prompt, verbatim
      appendSystemPromptOverride: () => [],
      additionalExtensionPaths: [permissionSystemExtensionPath()],
      extensionFactories: [
        { name: "owner-operator-privacy-tools", factory: blacklistAwareFileToolsExtension },
        { name: "owner-operator-permission-settings", factory: createPermissionSettingsExtension({ ooHome: paths.home }) },
        { name: "owner-operator-presentation", factory: ooPresentationExtension },
        { name: "owner-operator-agent-state", factory: agentStateExtension },
        {
          name: "owner-operator-onboarding",
          factory: createOnboardingExtension({
            ooHome: paths.home,
            piAgentDir: standalonePiAgentDir,
            sessionSourceEnv: standalonePiEnvironment,
            refreshConfiguration: async () => {
              authStorage.reload();
              await settingsManager.reload();
              refreshRegistry();
            },
          }),
        },
      ],
    },
  });
  refreshRegistry = () => services.modelRegistry.refresh();
  const created = await createAgentSessionFromServices({
    services,
    sessionManager,
    sessionStartEvent,
    tools: [...interactiveTools],
    customTools: ownerOperatorCustomTools,
  });
  return { ...created, services, diagnostics: services.diagnostics };
};

const runtime = await createAgentSessionRuntime(createRuntime, {
  cwd: process.cwd(),
  agentDir: paths.piAgentDir,
  sessionManager: createOoSession(ooProvenance("interactive")), // saved + labeled like every oo surface
});

initTheme(runtime.services.settingsManager.getTheme(), true);

// pi's stock banner is silenced via the supported `quietStartup` setting (.pi/settings.json).
// In its place: one quiet OO marker line. The TUI renders below it (no alt-screen), so it
// stays put in the scrollback the way pi's own startup notices do.
const ooVersion = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version ?? "0.0.0";
const ooTheme = buildOoTheme(getCapabilities().trueColor ? "truecolor" : "256color");
process.stdout.write(`${ooTheme.fg("accent", ooMarker(ooVersion))}\n`);

// Silent start: no auto model turn. The owner asks; the widget owns the "what's ongoing" view.
const interactive = new InteractiveMode(runtime, ooInteractiveOptions());
// Keep raw tool detail behind Pi's explicit expansion, strip reasoning from assistant messages,
// and silence startup notices. ooPresentationExtension owns the semantic timeline separately.
quietOoInteractiveMode(interactive);
await interactive.run();
