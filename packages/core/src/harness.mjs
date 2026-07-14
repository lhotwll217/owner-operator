import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_ACTIVE_WINDOW, isWindowSpec } from "./settings.mjs";

export const DEFAULT_SKILL_POLICY = Object.freeze({ mode: "owner-operator", allowlist: [] });
export const DEFAULT_TOOL_POSTURE = Object.freeze(["read", "grep", "find", "ls", "bash", "edit", "write"]);
export const DEFAULT_PERMISSION_MODE = "read-only";

const SKILL_MODES = new Set(["owner-operator", "all-personal", "allowlist"]);
const TOOL_NAMES = new Set(DEFAULT_TOOL_POSTURE);
const PERMISSION_MODES = new Set(["ask", "allow", "read-only"]);
const defaultHome = () => process.env.OO_HOME ?? join(homedir(), ".owner-operator");

export function ownerOperatorPaths(ooHome = defaultHome()) {
  const workspace = join(ooHome, "workspace");
  const piAgentDir = join(ooHome, "pi");
  return {
    home: ooHome,
    workspace,
    workspaceInstructions: join(workspace, "AGENTS.md"),
    workspaceMemory: join(workspace, "MEMORY.md"),
    workspaceSkills: join(workspace, "skills"),
    workspaceArtifacts: join(workspace, "artifacts"),
    piAgentDir,
    piAuth: join(piAgentDir, "auth.json"),
    piSettings: join(piAgentDir, "settings.json"),
    piModels: join(piAgentDir, "models.json"),
    piPermissionConfig: join(piAgentDir, "extensions", "pi-permission-system", "config.json"),
    imports: join(ooHome, "imports.json"),
    settings: join(ooHome, "settings.json"),
    onboardingMarker: join(ooHome, "onboarded.json"),
    blacklist: join(ooHome, "blacklist.json"),
    sessionSources: join(ooHome, "session_sources.json"),
    sessionHosts: join(ooHome, "session_hosts.json"),
  };
}

export function isPermissionMode(value) {
  return PERMISSION_MODES.has(value);
}

function writeMissing(path, content) {
  try {
    writeFileSync(path, content, { flag: "wx" });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
}

export function ensureOwnerOperatorWorkspace(ooHome = defaultHome()) {
  const paths = ownerOperatorPaths(ooHome);
  mkdirSync(paths.workspaceSkills, { recursive: true });
  mkdirSync(paths.workspaceArtifacts, { recursive: true });
  mkdirSync(paths.piAgentDir, { recursive: true });
  writeMissing(paths.workspaceInstructions, "# Owner Operator instructions\n\nRecord persistent instructions for the Operator here.\n");
  writeMissing(paths.workspaceMemory, "# Memory\n\nRecord durable facts for the Operator here.\n");
  return paths;
}

function readJson(path) {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

const cleanStrings = (values) => [...new Set(
  (Array.isArray(values) ? values : []).map((value) => String(value ?? "").trim()).filter(Boolean),
)];

function skillPolicy(value) {
  const mode = SKILL_MODES.has(value?.mode) ? value.mode : DEFAULT_SKILL_POLICY.mode;
  return { mode, allowlist: mode === "allowlist" ? cleanStrings(value?.allowlist) : [] };
}

export function loadHarnessSettings(ooHome = defaultHome()) {
  const raw = readJson(ownerOperatorPaths(ooHome).settings);
  return {
    activeWindow: typeof raw.activeWindow === "string" && isWindowSpec(raw.activeWindow)
      ? raw.activeWindow.trim()
      : DEFAULT_ACTIVE_WINDOW,
    skillPolicy: skillPolicy(raw.skillPolicy),
    toolPosture: cleanStrings(raw.toolPosture).filter((name) => TOOL_NAMES.has(name)).length
      ? cleanStrings(raw.toolPosture).filter((name) => TOOL_NAMES.has(name))
      : [...DEFAULT_TOOL_POSTURE],
    permissionMode: isPermissionMode(raw.permissionMode) ? raw.permissionMode : DEFAULT_PERMISSION_MODE,
    alwaysOn: raw.alwaysOn === "installed" || raw.alwaysOn === "declined" ? raw.alwaysOn : undefined,
  };
}

export function saveHarnessSettings(ooHome = defaultHome(), patch = {}) {
  const paths = ensureOwnerOperatorWorkspace(ooHome);
  const current = readJson(paths.settings);
  delete current.gatePolicy;
  const merged = {
    ...current,
    ...patch,
    ...(patch.skillPolicy ? { skillPolicy: skillPolicy(patch.skillPolicy) } : {}),
    ...(patch.toolPosture
      ? { toolPosture: cleanStrings(patch.toolPosture).filter((name) => TOOL_NAMES.has(name)) }
      : {}),
    ...(patch.permissionMode && isPermissionMode(patch.permissionMode)
      ? { permissionMode: patch.permissionMode }
      : {}),
  };
  if (Object.hasOwn(patch, "activeWindow") && !isWindowSpec(patch.activeWindow)) {
    throw new Error(`invalid active window "${patch.activeWindow}" — use Nh, Nd, today, or YYYY-MM-DD`);
  }
  if (Object.hasOwn(patch, "alwaysOn") && patch.alwaysOn !== "installed" && patch.alwaysOn !== "declined") {
    throw new Error('alwaysOn must be "installed" or "declined"');
  }
  writeFileSync(paths.settings, JSON.stringify(merged, null, 2) + "\n");
  return loadHarnessSettings(ooHome);
}
