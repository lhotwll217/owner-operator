import { EVENT_NAMES_SURVIVE_FROM } from "../../hooks/claude-settings";
import { installClaudeHooks, hookStatus, uninstallClaudeHooks, type HookInstallStatus } from "../../hooks/install";
import { emit, type Noun } from "./operation";

export const hookStatusReport = (status: HookInstallStatus): string => [
  `script    ${status.script}  ${status.scriptPath}`,
  `settings  ${status.settings}  ${status.settingsPath}`,
  `endpoint  ${status.endpoint}`,
  `claude    ${status.claudeVersion ?? "unknown"}`,
  ...(status.claudeVersion === null
    ? [`\n\`claude --version\` could not be read, so the installed hook events assume Claude Code`
      + ` ${EVENT_NAMES_SURVIVE_FROM} or newer, which skips an event name it does not know and keeps the rest of`
      + " the settings file in effect. An older Claude Code ignores the whole file instead, the"
      + " owner's own rules included, until `oo hooks uninstall` removes these events."]
    : []),
  ...(status.settings === "unparsable"
    ? [`\n${status.settingsPath} is not valid JSON, and Owner Operator will not change a settings`
      + " file it cannot parse. Fix the file, then run `oo hooks install`."]
    : []),
].join("\n");

const exitCode = (status: HookInstallStatus): number => (status.settings === "unparsable" ? 1 : 0);

export const hooks: Noun = {
  summary: "Claude Code hooks that report session lifecycle to the daemon",
  useWhen: "installing, removing, or checking the Claude Code hooks that drive Need You",
  guide: "Install merges one managed command per event into ~/.claude/settings.json and leaves every\n"
    + "other hook command in place. The script lives in $OO_HOME/hooks and re-reads endpoint.env\n"
    + "on each event, so a daemon restart does not strand a running Claude session. Onboarding\n"
    + "installs the same hooks. A settings file that does not parse is never written, and install\n"
    + "exits non-zero instead. The event set is gated on the installed Claude Code version, which\n"
    + "an older Claude Code needs because it rejects a whole settings file naming an event it does\n"
    + "not know. An unreadable version installs every event and status says the assumption.",
  verbs: {
    status: {
      summary: "whether the script, the settings entry, and the daemon endpoint are present",
      examples: ["oo hooks status", "oo hooks status --json"],
      async run({ json }) {
        const status = hookStatus();
        await emit(json, status, () => hookStatusReport(status));
        return status.script === "installed" && status.settings === "installed" ? 0 : 1;
      },
    },
    install: {
      summary: "install the managed Claude Code hooks without changing user hook commands",
      examples: ["oo hooks install", "oo hooks install --json"],
      async run({ json }) {
        const status = installClaudeHooks();
        await emit(json, status, () => hookStatusReport(status));
        return exitCode(status);
      },
    },
    uninstall: {
      summary: "remove only the managed Claude Code hook commands and the script",
      examples: ["oo hooks uninstall", "oo hooks uninstall --json"],
      async run({ json }) {
        const status = uninstallClaudeHooks();
        await emit(json, status, () => hookStatusReport(status));
        return exitCode(status);
      },
    },
  },
};
