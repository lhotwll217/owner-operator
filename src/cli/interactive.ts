// Owner Operator — pi's stock interactive mode, wired to our agent config. This is the
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
  AuthStorage,
  SettingsManager,
  getAgentDir,
  createAgentSessionServices,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  InteractiveMode,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import { getCapabilities } from "@earendil-works/pi-tui";
import { createOoSession, ooProvenance, ownerOperatorPrompt, ownerOperatorCustomTools, ownerOperatorTools, repoRoot } from "../agent/agent";
import { blacklistAwareFileToolsExtension } from "../agent/privacy-tools";
import { ownerOperatorResourceLoaderOptions } from "../agent/skills";
import { buildOoTheme, ooInteractiveOptions, ooMarker, ooPresentationExtension, quietOoInteractiveMode } from "../shared/oo-presentation";

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
      ...ownerOperatorResourceLoaderOptions(),
      systemPromptOverride: () => prompt,          // our owner-operator prompt, verbatim
      appendSystemPromptOverride: () => [],
      extensionFactories: [
        blacklistAwareFileToolsExtension,           // same-name read privacy override (only read is in the allowlist)
        ooPresentationExtension,                    // OO look: theme, single status line, tamed spinner
      ],
    },
  });
  const created = await createAgentSessionFromServices({
    services,
    sessionManager,
    sessionStartEvent,
    tools: [...ownerOperatorTools],
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

// pi's stock banner is silenced via the supported `quietStartup` setting (.pi/settings.json).
// In its place: one quiet OO marker line. The TUI renders below it (no alt-screen), so it
// stays put in the scrollback the way pi's own startup notices do.
const ooVersion = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version ?? "0.0.0";
const ooTheme = buildOoTheme(getCapabilities().trueColor ? "truecolor" : "256color");
process.stdout.write(`${ooTheme.fg("accent", ooMarker(ooVersion))}\n`);

// Silent start: no auto model turn. The owner asks; the widget owns the "what's ongoing" view.
const interactive = new InteractiveMode(runtime, ooInteractiveOptions());
// Zero-dump: drop pi's tool-execution rows, strip thinking from assistant messages, and silence
// startup update notices (no extension hook for any of them). During a turn the only moving part
// is the single working line driven by ooPresentationExtension.
quietOoInteractiveMode(interactive);
await interactive.run();
