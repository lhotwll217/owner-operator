import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_ACTIVE_WINDOW, isWindowSpec } from "./settings.mjs";

export const DEFAULT_SKILL_POLICY = Object.freeze({ mode: "owner-operator", allowlist: [] });
export const DEFAULT_TOOL_POSTURE = Object.freeze(["read", "grep", "find", "ls", "bash", "edit", "write"]);
export const DEFAULT_GATE_POLICY = Object.freeze({
  interactive: Object.freeze({ edit: "ask", write: "ask", riskyBash: "ask" }),
  headless: Object.freeze({ edit: "deny", write: "deny", riskyBash: "deny" }),
});

const SKILL_MODES = new Set(["owner-operator", "all-personal", "allowlist"]);
const TOOL_NAMES = new Set(DEFAULT_TOOL_POSTURE);
const GATE_ACTIONS = new Set(["allow", "ask", "deny"]);
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
    imports: join(ooHome, "imports.json"),
    settings: join(ooHome, "settings.json"),
    onboardingMarker: join(ooHome, "onboarded.json"),
    blacklist: join(ooHome, "blacklist.json"),
    sessionSources: join(ooHome, "session_sources.json"),
    sessionHosts: join(ooHome, "session_hosts.json"),
  };
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

function gatePolicy(value) {
  const readSurface = (surface) => Object.fromEntries(
    ["edit", "write", "riskyBash"].map((operation) => {
      const configured = value?.[surface]?.[operation];
      return [operation, GATE_ACTIONS.has(configured) ? configured : DEFAULT_GATE_POLICY[surface][operation]];
    }),
  );
  return { interactive: readSurface("interactive"), headless: readSurface("headless") };
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
    gatePolicy: gatePolicy(raw.gatePolicy),
    alwaysOn: raw.alwaysOn === "installed" || raw.alwaysOn === "declined" ? raw.alwaysOn : undefined,
  };
}

export function saveHarnessSettings(ooHome = defaultHome(), patch = {}) {
  const paths = ensureOwnerOperatorWorkspace(ooHome);
  const current = readJson(paths.settings);
  const currentGatePolicy = loadHarnessSettings(ooHome).gatePolicy;
  const merged = {
    ...current,
    ...patch,
    ...(patch.skillPolicy ? { skillPolicy: skillPolicy(patch.skillPolicy) } : {}),
    ...(patch.toolPosture
      ? { toolPosture: cleanStrings(patch.toolPosture).filter((name) => TOOL_NAMES.has(name)) }
      : {}),
    ...(patch.gatePolicy ? {
      gatePolicy: gatePolicy({
        interactive: {
          ...currentGatePolicy.interactive,
          ...patch.gatePolicy.interactive,
        },
        headless: {
          ...currentGatePolicy.headless,
          ...patch.gatePolicy.headless,
        },
      }),
    } : {}),
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
