import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  ensureOwnerOperatorWorkspace,
  isOnboarded,
  loadHarnessSettings,
  loadSessionHosts,
  loadTranscriptStores,
} from "@owner-operator/core";
import { repoRoot } from "../shared/repo-root";

export interface HarnessDoctorOptions {
  ooHome?: string;
  userHome?: string;
  taskCwd?: string;
  installRoot?: string;
  personalSkillsRoot?: string;
}

function readObject(path: string): Record<string, unknown> {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

export function formatHarnessDoctor(options: HarnessDoctorOptions = {}): string {
  const paths = ensureOwnerOperatorWorkspace(options.ooHome);
  const ready = isOnboarded(paths.home);
  const settings = loadHarnessSettings(paths.home);
  const imports = readObject(paths.imports).pi as Record<string, unknown> | undefined;
  const auth = readObject(paths.piAuth);
  const piSettings = readObject(paths.piSettings);
  const providerCount = Object.keys(auth).length;
  const providerLabel = `${providerCount} provider${providerCount === 1 ? "" : "s"}`;
  const importedFrom = typeof imports?.source === "string" ? `; imported from ${imports.source}` : "";
  const provider = typeof piSettings.defaultProvider === "string" ? piSettings.defaultProvider : undefined;
  const model = typeof piSettings.defaultModel === "string" ? piSettings.defaultModel : undefined;
  const userHome = options.userHome ?? homedir();
  const personalRoot = options.personalSkillsRoot ?? join(userHome, ".agents", "skills");
  const personal = settings.skillPolicy.mode === "owner-operator"
    ? "disabled"
    : settings.skillPolicy.mode === "all-personal"
      ? `all from ${personalRoot}`
      : `allowlist from ${personalRoot}: ${settings.skillPolicy.allowlist.join(", ") || "(empty)"}`;
  const permissionMode = settings.permissionMode === "ask"
    ? "ask before shell commands and changes"
    : settings.permissionMode === "allow"
      ? "allow shell commands and changes"
      : "read-only (no shell)";
  const transcriptStores = ready
    ? loadTranscriptStores(paths.home).map(({ format, root }) => `${format}=${root}`).join(", ") || "(none)"
    : "(none until setup)";
  const hostRoots = ready
    ? loadSessionHosts(paths.home, { home: userHome }).flatMap((host) => host.roots
      .filter((root) => existsSync(root))
      .map((root) => `${host.label}=${root}`)).join(", ") || "(none)"
    : "(none until setup)";

  return [
    `Status: ${ready ? "ready" : "setup required"}`,
    `Install root: ${options.installRoot ?? repoRoot}`,
    `Harness home: ${paths.home}`,
    `Workspace: ${paths.workspace}`,
    `Task cwd: ${options.taskCwd ?? process.cwd()}`,
    `Context: ${existsSync(paths.workspaceInstructions) ? paths.workspaceInstructions : "(missing)"}`,
    "Skill precedence:",
    `  1 bundled: ${join(options.installRoot ?? repoRoot, "src", "agent", "skills")}`,
    `  2 workspace: ${paths.workspaceSkills}`,
    `  3 personal ${personal}`,
    `Config: ${paths.settings}`,
    `Credentials: ${paths.piAuth} (${providerLabel}${importedFrom})`,
    `Model settings: ${paths.piSettings}`,
    `Permission config: ${paths.piPermissionConfig}`,
    `Model: ${provider && model ? `${provider}/${model}` : "not configured"}`,
    `Transcript stores: ${transcriptStores}`,
    `Session host roots: ${hostRoots}`,
    `Tool posture: ${settings.toolPosture.join(", ")}`,
    `Default permissions: ${permissionMode}`,
    "Reload: new headless/scheduled sessions reload workspace resources; interactive uses /reload or a new session; extension changes require restart.",
  ].join("\n") + "\n";
}
