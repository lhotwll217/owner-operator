import { existsSync, linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_ACTIVE_WINDOW, isWindowSpec } from "./settings.mjs";

export const DEFAULT_SKILL_POLICY = Object.freeze({ mode: "owner-operator", allowlist: [] });
export const DEFAULT_TOOL_POSTURE = Object.freeze(["read", "grep", "find", "ls", "bash", "edit", "write"]);
export const DEFAULT_PERMISSION_MODE = "allow";

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
    userHarnessPreferences: join(workspace, "user-harness-preferences.md"),
    delegatedBaselines: join(ooHome, "delegated-baselines"),
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

/** The preferences are the owner's file. Seeding seeds rules and empty roles only: a guessed harness,
 * model, or effort here would read as a decision the owner made, and the owner would then have to
 * discover and undo it. Delegated model/effort baselines are approved separately and stored in
 * delegated-baselines/, so nothing the product decides is ever written into this file. */
export const USER_HARNESS_PREFERENCES_TEMPLATE = `# User harness preferences

Your preferences for the coding agents Owner Operator delegates work to. This file is yours:
Owner Operator edits it only at your explicit direction, and product upgrades leave it alone.

Under a role, name a harness, a model, and a reasoning effort, or write the preference in plain
language. Model identifiers belong to one harness and are not interchangeable between harnesses;
Owner Operator can report what each harness currently advertises before you name one.

## Rules

- A harness, model, or effort you state in a request always wins over these preferences.
- Owner Operator reads current harness facts before delegating without an explicit choice.
- When a preferred choice is unavailable, Owner Operator may use an alternative only if it
  preserves the quality the work needs, and says so in the conversation.
- Where no role below applies, Owner Operator falls back to the delegated baseline you approved
  for that harness, which is stored outside this file.
- A delegated run uses whichever account its harness CLI is signed into on this machine; the run
  is billed to that account and the task's code is sent to it.

## Task roles

### Implementation

_No preference configured._

### Research

_No preference configured._

### Review

_No preference configured._

### Quick mechanical work

_No preference configured._

## Custom roles

Add roles of your own below, as headings in the same shape. Owner Operator reads them alongside
the roles above.
`;

const legacyHarnessRosterPath = (workspace) => join(workspace, "harness-roster.md");

/** Resolve the one active owner-preference file before seeding. The optional operations exist so
 * migration races and failures can be exercised without weakening the production filesystem path. */
export function resolveUserHarnessPreferences(ooHome = defaultHome(), operations = {}) {
  const paths = ownerOperatorPaths(ooHome);
  const exists = operations.existsSync ?? existsSync;
  const link = operations.linkSync ?? linkSync;
  const unlink = operations.unlinkSync ?? unlinkSync;
  const write = operations.writeFileSync ?? writeFileSync;
  const canonical = paths.userHarnessPreferences;
  const legacy = legacyHarnessRosterPath(paths.workspace);
  mkdirSync(paths.workspace, { recursive: true });

  const initial = existingPreferencesResolution(canonical, legacy, exists);
  if (initial.source === "user-harness-preferences") return initial;

  if (initial.source === "legacy-harness-roster") {
    try {
      // link(2) is exclusive: unlike rename, it cannot replace canonical bytes created by
      // another process between the existence check and this migration attempt.
      link(legacy, canonical);
      unlink(legacy);
    } catch (error) {
      const resolved = existingPreferencesResolution(canonical, legacy, exists);
      if (resolved.source === "user-harness-preferences") return resolved;
      return resolved.source === "legacy-harness-roster"
        ? {
            ...resolved,
            error: `Could not migrate ${legacy} to ${canonical}: ${messageOf(error)}. Using the legacy file without rewriting it.`,
          }
        : {
            path: canonical,
            source: null,
            error: `Could not migrate ${legacy} to ${canonical}: ${messageOf(error)}. Neither preference file is now available.`,
          };
    }
    const resolved = existingPreferencesResolution(canonical, legacy, exists);
    return resolved.source
      ? resolved
      : {
          path: canonical,
          source: null,
          error: `Migrated ${legacy} to ${canonical}, but neither preference file is now available.`,
        };
  }

  try {
    write(canonical, USER_HARNESS_PREFERENCES_TEMPLATE, { flag: "wx" });
  } catch (error) {
    if (error?.code !== "EEXIST") {
      return {
        path: canonical,
        source: null,
        error: `Could not create ${canonical}: ${messageOf(error)}`,
      };
    }
  }
  const resolved = existingPreferencesResolution(canonical, legacy, exists);
  return resolved.source
    ? resolved
    : {
        path: canonical,
        source: null,
        error: `Could not resolve ${canonical} after creating it.`,
      };
}

function existingPreferencesResolution(canonical, legacy, exists) {
  const canonicalExists = exists(canonical);
  const legacyExists = exists(legacy);
  if (canonicalExists) {
    return {
      path: canonical,
      source: "user-harness-preferences",
      error: legacyExists
        ? `Both ${canonical} and legacy ${legacy} exist; using the canonical file and leaving the legacy file untouched.`
        : null,
    };
  }
  return legacyExists
    ? { path: legacy, source: "legacy-harness-roster", error: null }
    : { path: canonical, source: null, error: null };
}

export function ensureOwnerOperatorWorkspace(ooHome = defaultHome()) {
  const paths = ownerOperatorPaths(ooHome);
  mkdirSync(paths.workspaceSkills, { recursive: true });
  mkdirSync(paths.workspaceArtifacts, { recursive: true });
  mkdirSync(paths.piAgentDir, { recursive: true });
  writeMissing(paths.workspaceInstructions, "# Owner Operator instructions\n\nRecord persistent instructions for the Operator here.\n");
  writeMissing(paths.workspaceMemory, "# Memory\n\nRecord durable facts for the Operator here.\n");
  resolveUserHarnessPreferences(ooHome);
  return paths;
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function readJson(path) {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function readHarnessSettings(path) {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? { valid: true, value }
      : { valid: false, value: {} };
  } catch (error) {
    return error?.code === "ENOENT"
      ? { valid: true, value: {} }
      : { valid: false, value: {} };
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
  const document = readHarnessSettings(ownerOperatorPaths(ooHome).settings);
  const raw = document.value;
  const permissionMode = !document.valid || (Object.hasOwn(raw, "permissionMode") && !isPermissionMode(raw.permissionMode))
    ? "read-only"
    : isPermissionMode(raw.permissionMode) ? raw.permissionMode : DEFAULT_PERMISSION_MODE;
  return {
    activeWindow: typeof raw.activeWindow === "string" && isWindowSpec(raw.activeWindow)
      ? raw.activeWindow.trim()
      : DEFAULT_ACTIVE_WINDOW,
    skillPolicy: skillPolicy(raw.skillPolicy),
    toolPosture: cleanStrings(raw.toolPosture).filter((name) => TOOL_NAMES.has(name)).length
      ? cleanStrings(raw.toolPosture).filter((name) => TOOL_NAMES.has(name))
      : [...DEFAULT_TOOL_POSTURE],
    permissionMode,
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
