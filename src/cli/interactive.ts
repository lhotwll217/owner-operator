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
  createOwnerOperatorCustomTools,
  configuredOwnerOperatorTools,
  ooProvenance,
  ownerOperatorPiServices,
  ownerOperatorPrompt,
  ownerOperatorTaskCwd,
  repoRoot,
} from "../agent/agent";
import { createPrivacyToolGuardExtension } from "../agent/privacy-tools";
import {
  configurePermissionSystemEnvironment,
  createPermissionSettingsExtension,
  permissionSystemExtensionPath,
} from "../agent/permission-settings";
import { createOnboardingExtension } from "../agent/onboarding";
import { ownerOperatorResourceLoaderOptions } from "../agent/skills";
import { createOwnerOperatorToolDisplayExtension } from "../agent/tool-display";
import {
  createWorktreeRuntimeRebindExtension,
  InteractiveSessionReplacement,
  PendingWorktreeCwdChanges,
  resolveInteractiveRuntimeTarget,
  resolveOwnerOperatorTaskCwd,
} from "../agent/worktree-runtime";
import { agentStateExtension } from "../agent-runs/agent-state-extension";
import { buildOoTheme, ooInteractiveOptions, ooMarker, ooPresentationExtension } from "../shared/oo-presentation";

if (!process.stdout.isTTY) {
  console.error("Owner Operator interactive mode needs an interactive terminal.\nUse `./oo` in a real terminal, or `./oo \"question\"` for a headless single turn.");
  process.exit(1);
}

const prompt = ownerOperatorPrompt();
const provenance = ooProvenance("interactive");
// Permission-system initialization points Pi at OO_HOME. Preserve standalone Pi discovery inputs
// first so onboarding never offers Owner Operator's own sessions as an external transcript source.
const standalonePiEnvironment = { ...process.env };
const standalonePiAgentDir = getAgentDir();
const { modelRuntime, paths } = await ownerOperatorPiServices();
configurePermissionSystemEnvironment(paths);
const interactiveTools = configuredOwnerOperatorTools(paths.home);
const invocationCwd = ownerOperatorTaskCwd();
const pendingCwdChanges = new PendingWorktreeCwdChanges();
const sessionReplacement = new InteractiveSessionReplacement();
const interactiveCustomTools = createOwnerOperatorCustomTools({}, {
  onWorktreeSelection: (threadId) => pendingCwdChanges.record(threadId),
});
const ownerOperatorToolDisplayExtension = await createOwnerOperatorToolDisplayExtension(
  paths.piAgentDir,
  interactiveCustomTools,
);
let runtime: Awaited<ReturnType<typeof createAgentSessionRuntime>> | undefined;
const worktreeRuntimeRebindExtension = createWorktreeRuntimeRebindExtension({
  pending: pendingCwdChanges,
  replacement: sessionReplacement,
  rebind: async (threadId) => {
    if (!runtime) throw new Error("interactive runtime is not ready");
    const manager = runtime.session.sessionManager;
    if (manager.getSessionId() !== threadId) {
      throw new Error(`pending cwd change belongs to inactive session ${threadId}`);
    }
    const sessionFile = manager.getSessionFile();
    if (!sessionFile) throw new Error(`session ${threadId} has no persisted transcript`);
    // Pi tears down the current runtime before calling its factory. Resolve once first so a
    // missing or invalid selected worktree leaves the current session intact and usable.
    await resolveOwnerOperatorTaskCwd(manager, invocationCwd);
    await runtime.switchSession(sessionFile);
  },
});

// The runtime factory pi reuses for /new, /resume, /fork resolves the active stable session ID
// before rebuilding our cwd-bound services. The privacy guard reads that live session ID.
const createRuntime: Parameters<typeof createAgentSessionRuntime>[0] = async ({ sessionManager, sessionStartEvent }) => {
  const target = await resolveInteractiveRuntimeTarget(
    sessionManager,
    sessionStartEvent,
    provenance,
    invocationCwd,
  );
  const replacedThreadId = sessionReplacement.complete();
  if (replacedThreadId) pendingCwdChanges.discard(replacedThreadId);
  const { settingsManager } = await ownerOperatorPiServices(paths.home);
  const services = await createAgentSessionServices({
    cwd: target.cwd,
    agentDir: paths.piAgentDir,
    modelRuntime,
    settingsManager,
    resourceLoaderOptions: {
      ...ownerOperatorResourceLoaderOptions(),
      systemPromptOverride: () => prompt,          // our owner-operator prompt, verbatim
      appendSystemPromptOverride: () => [],
      additionalExtensionPaths: [permissionSystemExtensionPath()],
      extensionFactories: [
        { name: "owner-operator-tool-display", factory: ownerOperatorToolDisplayExtension },
        {
          name: "owner-operator-privacy-guard",
          factory: createPrivacyToolGuardExtension({ callerSessionId: provenance.fromSession }),
        },
        { name: "owner-operator-permission-settings", factory: createPermissionSettingsExtension({ ooHome: paths.home }) },
        { name: "owner-operator-presentation", factory: ooPresentationExtension },
        { name: "owner-operator-agent-state", factory: agentStateExtension },
        { name: "owner-operator-worktree-runtime-rebind", factory: worktreeRuntimeRebindExtension },
        {
          name: "owner-operator-onboarding",
          factory: createOnboardingExtension({
            ooHome: paths.home,
            piAgentDir: standalonePiAgentDir,
            sessionSourceEnv: standalonePiEnvironment,
            refreshConfiguration: async () => {
              await settingsManager.reload();
              await modelRuntime.refresh();
            },
          }),
        },
      ],
    },
  });
  const created = await createAgentSessionFromServices({
    services,
    sessionManager: target.sessionManager,
    sessionStartEvent,
    tools: [...interactiveTools],
  });
  return { ...created, services, diagnostics: services.diagnostics };
};

runtime = await createAgentSessionRuntime(createRuntime, {
  cwd: invocationCwd,
  agentDir: paths.piAgentDir,
  sessionManager: createOoSession(provenance), // saved + labeled like every oo surface
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
await interactive.run();
