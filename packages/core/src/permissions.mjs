import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parse } from "jsonc-parser";
import { loadBlacklist } from "./blacklist.mjs";
import {
  DEFAULT_PERMISSION_MODE,
  ensureOwnerOperatorWorkspace,
  isPermissionMode,
  loadHarnessSettings,
  saveHarnessSettings,
} from "./harness.mjs";

const BLACKLIST_REASON = "Owner Operator privacy blacklist";
const READ_SURFACES = ["read", "grep", "find", "ls", "skill", "get_current_session_state", "query_database"];
const CHANGE_SURFACES = ["edit", "write", "mark_thread_done", "schedule_prompt"];

function readJson(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw new Error(`cannot read Pi permission config at ${path}`, { cause: error });
  }
  const errors = [];
  const value = parse(raw, errors);
  if (errors.length || !isRecord(value)) throw new Error(`invalid Pi permission config at ${path}`);
  return value;
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n");
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
    pathRules[blocked] = generatedRule;
    pathRules[`${blocked}/*`] = generatedRule;
  }
  next.path = pathRules;
  return next;
}

export function reconcilePermissionSettings(ooHome) {
  const paths = ensureOwnerOperatorWorkspace(ooHome);
  const existing = readJson(paths.piPermissionConfig);
  const existingPermission = isRecord(existing.permission) ? existing.permission : {};
  const mode = loadHarnessSettings(paths.home).permissionMode;
  const next = { ...existing, permission: permissionPolicy(existingPermission, paths.home, mode) };
  writeJsonAtomic(paths.piPermissionConfig, next);
  return next;
}

export function savePermissionMode(ooHome, mode = DEFAULT_PERMISSION_MODE) {
  if (!isPermissionMode(mode)) throw new Error(`invalid permission mode "${mode}"`);
  saveHarnessSettings(ooHome, { permissionMode: mode });
  return reconcilePermissionSettings(ooHome);
}
