import { installClaudeHooks, hookStatus, uninstallClaudeHooks, type HookInstallStatus } from "../../hooks/install";
import { emit, type Noun } from "./operation";

const line = (status: HookInstallStatus): string => [
  `script    ${status.script}  ${status.scriptPath}`,
  `settings  ${status.settings}  ${status.settingsPath}`,
  `endpoint  ${status.endpoint}`,
].join("\n");

export const hooks: Noun = {
  summary: "Claude Code hooks that report session lifecycle to the daemon",
  useWhen: "installing, removing, or checking the Claude Code hooks that drive Need You",
  guide: "Install merges one managed command per event into ~/.claude/settings.json and leaves every\n"
    + "other hook command in place. The script lives in $OO_HOME/hooks and re-reads endpoint.env\n"
    + "on each event, so a daemon restart does not strand a running Claude session. Onboarding\n"
    + "installs the same hooks.",
  verbs: {
    status: {
      summary: "whether the script, the settings entry, and the daemon endpoint are present",
      examples: ["oo hooks status", "oo hooks status --json"],
      async run({ json }) {
        const status = hookStatus();
        await emit(json, status, () => line(status));
        return status.script === "installed" && status.settings === "installed" ? 0 : 1;
      },
    },
    install: {
      summary: "install the managed Claude Code hooks without changing user hook commands",
      examples: ["oo hooks install", "oo hooks install --json"],
      async run({ json }) {
        const status = installClaudeHooks();
        await emit(json, status, () => line(status));
        return 0;
      },
    },
    uninstall: {
      summary: "remove only the managed Claude Code hook commands and the script",
      examples: ["oo hooks uninstall", "oo hooks uninstall --json"],
      async run({ json }) {
        const status = uninstallClaudeHooks();
        await emit(json, status, () => line(status));
        return 0;
      },
    },
  },
};
