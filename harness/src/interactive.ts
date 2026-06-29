// Owner Operator — pi's STOCK interactive mode, wired to OUR agent config. A second frontend,
// flagged on, to A/B against the branded TUI (tui.ts): same system prompt, skills, tool
// allowlist, custom tools, and model — but pi's native chat shell (its Editor with slash-command
// autocomplete + history, FooterComponent, message/tool components, theme) instead of our
// hand-rolled one. The branded TUI stays the default; this is the "use the shared pattern" surface.
//
//   ./harness/oo --interactive    (alias -i)    ·    OO_INTERACTIVE=1 ./harness/oo
//
// Built by mirroring pi's own main.ts runtime wiring — createAgentSessionServices →
// createAgentSessionFromServices → createAgentSessionRuntime → new InteractiveMode(runtime).run()
// — but feeding it OUR services (prompt override + custom tools) instead of the CLI's defaults.
//
// Known gap (worth seeing): present_threads is a structured-output tool whose CARD rendering
// lives in our surfaces (cards.ts / the sidebar). pi's stock InteractiveMode has no renderer for
// it, so triage shows here as the tool call + its text result — exactly the kind of trade-off
// this surface lets us evaluate against the branded TUI.

import {
  AuthStorage,
  SettingsManager,
  SessionManager,
  getAgentDir,
  createAgentSessionServices,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  InteractiveMode,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import { ownerOperatorPrompt, ownerOperatorCustomTools, ownerOperatorTools, repoRoot } from "./agent";

if (!process.stdout.isTTY) {
  console.error("Owner Operator interactive mode needs an interactive terminal.\nUse `./harness/oo --interactive` in a real terminal, or `./harness/oo \"question\"` for a one-shot.");
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
  sessionManager: SessionManager.inMemory(repoRoot), // no on-disk pi session files, like the other frontends
});

initTheme(runtime.services.settingsManager.getTheme(), true);

// Open on the same fresh triage the branded TUI runs at launch, so both surfaces test the
// identical first turn.
const interactive = new InteractiveMode(runtime, {
  initialMessage: "What's ongoing today? Run get-active-threads, then triage every active thread with present_threads, most-urgent first.",
});
await interactive.run();
