// Owner Operator — pi's STOCK interactive mode, wired to OUR agent config. The DEFAULT
// terminal surface: same system prompt, skills, tool allowlist, custom tools, and model as
// the branded TUI (tui.ts), but pi's native chat shell (its Editor with slash-command
// autocomplete + history, FooterComponent, message/tool components, theme) instead of our
// hand-rolled one. The branded TUI (--tui) is the A/B surface — its pinned sidebar is its
// reason to exist.
//
//   ./harness/oo    (bare — this is the default surface)
//
// Built by mirroring pi's own main.ts runtime wiring — createAgentSessionServices →
// createAgentSessionFromServices → createAgentSessionRuntime → new InteractiveMode(runtime).run()
// — but feeding it OUR services (prompt override + custom tools + our extension).
//
// ownerOperatorExtension (oo-extension.ts) makes the stock shell behave like ours WITHOUT a
// hand-rolled UI: it renders present_threads triage as our cards inline (closing the gap where
// stock mode showed triage as a bare tool-result), and registers /done, /threads, and /help as
// real slash commands with autocomplete — proof that the extension seams cover what tui.ts does
// by hand. The one thing they can't reproduce is the pinned left-column sidebar (widgets only
// sit above/below the editor); that remains the branded TUI's reason to exist.

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
import { ownerOperatorExtension } from "../agent/oo-extension";

if (!process.stdout.isTTY) {
  console.error("Owner Operator interactive mode needs an interactive terminal.\nUse `./harness/oo` in a real terminal, or `./harness/oo \"question\"` for a one-shot.");
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
      extensionFactories: [ownerOperatorExtension], // cards renderer + /done, /threads, /help
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

// Open on the same fresh triage the branded TUI runs at launch, so both surfaces test the
// identical first turn.
const interactive = new InteractiveMode(runtime, {
  initialMessage: "What's ongoing today? Read get_current_session_state for the authoritative row set, run the scan-active-transcripts skill for message samples, then triage with present_threads — every active row, merged with anything new the scan found, most-urgent first.",
});
await interactive.run();
