import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { applyEdits, modify, parse } from "jsonc-parser";
import { loadBlacklist, pathIdentities } from "./blacklist.mjs";
import {
  DEFAULT_PERMISSION_MODE,
  ensureOwnerOperatorWorkspace,
  isPermissionMode,
  loadHarnessSettings,
  saveHarnessSettings,
} from "./harness.mjs";

const BLACKLIST_REASON = "Owner Operator privacy blacklist";
// Keep these explicit defaults aligned with src/agent/tools/index.ts. Unlisted tools safely fall
// back to the selected mode; the lists only identify known read and change surfaces.
const READ_SURFACES = ["read", "grep", "find", "ls", "skill", "get_current_session_state", "query_database"];
const CHANGE_SURFACES = ["edit", "write", "mark_thread_done", "schedule_prompt"];
const MANAGED_SURFACES = [...READ_SURFACES, ...CHANGE_SURFACES, "external_directory", "bash"];
const JSON_FORMAT = { insertSpaces: true, tabSize: 2, eol: "\n" };

function readDocument(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { raw: "{}\n", value: {} };
    throw new Error(`cannot read Pi permission config at ${path}`, { cause: error });
  }
  const errors = [];
  const value = parse(raw, errors);
  if (errors.length || !isRecord(value)) throw new Error(`invalid Pi permission config at ${path}`);
  return { raw, value };
}

function writeTextAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, value.endsWith("\n") ? value : `${value}\n`);
    renameSync(temporary, path);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* no temporary file to remove */ }
    throw error;
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function patternMap(value) {
  return isRecord(value) && !("action" in value) ? { ...value } : {};
}

function isPatternMap(value) {
  return isRecord(value) && !("action" in value);
}

function withDefault(value, action) {
  const rules = patternMap(value);
  delete rules["*"];
  return { "*": action, ...rules };
}

function isGeneratedBlacklistRule(value) {
  return isRecord(value) && value.action === "deny" && value.reason === BLACKLIST_REASON;
}

function changeAction(mode) {
  return mode === "allow" ? "allow" : mode === "read-only" ? "deny" : "ask";
}

function permissionPolicy(existing, ooHome, mode) {
  const action = changeAction(mode);
  const next = { ...existing, "*": action };
  for (const surface of READ_SURFACES) next[surface] = withDefault(existing[surface], "allow");
  for (const surface of CHANGE_SURFACES) next[surface] = withDefault(existing[surface], action);
  next.external_directory = withDefault(existing.external_directory, "allow");
  next.bash = withDefault(existing.bash, action);

  const currentPathRules = patternMap(existing.path);
  const ownerPathRules = {};
  for (const [pattern, value] of Object.entries(currentPathRules)) {
    if (pattern !== "*" && !isGeneratedBlacklistRule(value)) ownerPathRules[pattern] = value;
  }
  const generatedRule = { action: "deny", reason: BLACKLIST_REASON };
  const pathRules = { "*": "allow", ...ownerPathRules };
  for (const blocked of loadBlacklist(ooHome).paths) {
    for (const identity of pathIdentities(blocked)) {
      pathRules[identity] = generatedRule;
      pathRules[`${identity}/*`] = generatedRule;
    }
  }
  next.path = pathRules;
  return next;
}

function setJsoncValue(text, path, value, first = false) {
  return applyEdits(text, modify(text, path, value, {
    formattingOptions: JSON_FORMAT,
    ...(first ? { getInsertionIndex: () => 0 } : {}),
  }));
}

function reconcilePermissionDocument(text, existingPermission, nextPermission) {
  if (!isRecord(existingPermission)) return setJsoncValue(text, ["permission"], nextPermission);

  let nextText = setJsoncValue(text, ["permission", "*"], nextPermission["*"], true);
  for (const surface of MANAGED_SURFACES) {
    nextText = isPatternMap(existingPermission[surface])
      ? setJsoncValue(nextText, ["permission", surface, "*"], nextPermission[surface]["*"], true)
      : setJsoncValue(nextText, ["permission", surface], nextPermission[surface]);
  }

  const existingPath = existingPermission.path;
  if (!isPatternMap(existingPath)) return setJsoncValue(nextText, ["permission", "path"], nextPermission.path);

  nextText = setJsoncValue(nextText, ["permission", "path", "*"], nextPermission.path["*"], true);
  for (const [pattern, value] of Object.entries(existingPath)) {
    if (isGeneratedBlacklistRule(value)) {
      nextText = setJsoncValue(nextText, ["permission", "path", pattern], undefined);
    }
  }
  for (const [pattern, value] of Object.entries(nextPermission.path)) {
    if (isGeneratedBlacklistRule(value)) {
      nextText = setJsoncValue(nextText, ["permission", "path", pattern], value);
    }
  }
  return nextText;
}

export function reconcilePermissionSettings(ooHome) {
  const paths = ensureOwnerOperatorWorkspace(ooHome);
  const { raw, value: existing } = readDocument(paths.piPermissionConfig);
  const existingPermission = isRecord(existing.permission) ? existing.permission : {};
  const mode = loadHarnessSettings(paths.home).permissionMode;
  const nextPermission = permissionPolicy(existingPermission, paths.home, mode);
  const next = { ...existing, permission: nextPermission };
  writeTextAtomic(
    paths.piPermissionConfig,
    reconcilePermissionDocument(raw, existing.permission, nextPermission),
  );
  return next;
}

export function savePermissionMode(ooHome, mode = DEFAULT_PERMISSION_MODE) {
  if (!isPermissionMode(mode)) throw new Error(`invalid permission mode "${mode}"`);
  saveHarnessSettings(ooHome, { permissionMode: mode });
  return reconcilePermissionSettings(ooHome);
}
