// Owner Operator — first-run onboarding state. The config loaders (blacklist, session-sources,
// settings) only READ; the guided setup flow needs to WRITE the same files, plus a marker so it
// runs once. This is that write half; source-detection.mjs owns the bounded discovery read side.
//
// Additive writers merge and de-duplicate. The confirmed source-aperture writer replaces only its
// `disable`/`add` fields so re-running setup can remove consent. Plain ESM (not TS) lets the
// zero-install scan skill import the same API. Types: onboarding.d.mts.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadBlacklist } from "./blacklist.mjs";
import {
  KNOWN_AGENT_HARNESSES,
  AGENT_HARNESS_DESCRIPTORS,
  KNOWN_SESSION_SOURCES,
  KNOWN_TRANSCRIPT_FORMATS,
} from "./session-sources.mjs";
import { KNOWN_SESSION_HOSTS, REVIEWED_SESSION_HOSTS, SESSION_HOST_DESCRIPTORS } from "./session-hosts.mjs";
import { isWindowSpec } from "./settings.mjs";
import { ensureOwnerOperatorWorkspace } from "./harness.mjs";

// Bumped when the flow gains a consent the owner must review. Catalog IDs are checked separately,
// so adding a supported harness or owner-facing host reopens only that inventory step.
export const ONBOARDING_VERSION = 3;
const AUTH_CONSENT_VERSION = 1;
const SESSION_CATALOG_HASH = createHash("sha256").update(JSON.stringify({
  harnesses: AGENT_HARNESS_DESCRIPTORS,
  hosts: SESSION_HOST_DESCRIPTORS.filter(({ review }) => review),
})).digest("hex");
export const ONBOARDING_STEPS = Object.freeze([
  "intro",
  "privacy",
  "auth",
  "session-sources",
  "always-on",
  "active-window",
  "skills",
]);

const defaultHome = () => process.env.OO_HOME ?? join(homedir(), ".owner-operator");

// Create <ooHome> on demand — the writers own the dir the loaders only ever read.
function ensureHome(ooHome) {
  mkdirSync(ooHome, { recursive: true });
  return ooHome;
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")) || {}; } catch { return {}; }
}

// Pretty, newline-terminated — these files get hand-edited, so keep them diff-friendly.
function writeJson(path, value, options) {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", options);
}

const uniq = (xs) => [...new Set(xs)];
const sameStrings = (left, right) => {
  if (!Array.isArray(left) || left.length !== right.length) return false;
  const expected = [...right].sort();
  return [...left].sort().every((value, index) => value === expected[index]);
};

export function pendingOnboardingSteps(ooHome = defaultHome()) {
  const marker = readJson(join(ooHome, "onboarded.json"));
  const completed = new Set(Array.isArray(marker.completed) ? marker.completed : []);
  const catalogCurrent =
    sameStrings(marker.reviewedHarnesses, KNOWN_AGENT_HARNESSES) &&
    sameStrings(marker.reviewedSessionHosts, REVIEWED_SESSION_HOSTS) &&
    marker.sessionCatalogHash === SESSION_CATALOG_HASH;
  return ONBOARDING_STEPS.filter((step) =>
    !completed.has(step) ||
    (step === "auth" && marker.authVersion !== AUTH_CONSENT_VERSION) ||
    (step === "session-sources" && !catalogCurrent));
}

/** True once every current consent step has completed at the current marker version. */
export function isOnboarded(ooHome = defaultHome()) {
  const m = readJson(join(ooHome, "onboarded.json"));
  return m.version === ONBOARDING_VERSION && pendingOnboardingSteps(ooHome).length === 0;
}

export function markOnboardingStep(ooHome = defaultHome(), step, extra = {}) {
  if (!ONBOARDING_STEPS.includes(step)) throw new Error(`unknown onboarding step "${step}"`);
  ensureHome(ooHome);
  const path = join(ooHome, "onboarded.json");
  const current = readJson(path);
  const completed = uniq([...(Array.isArray(current.completed) ? current.completed : []), step]);
  const marker = {
    ...current,
    version: ONBOARDING_VERSION,
    completed,
    ...(step === "auth" ? { authVersion: AUTH_CONSENT_VERSION } : {}),
    ...(step === "session-sources" ? { sessionCatalogHash: SESSION_CATALOG_HASH } : {}),
    updatedAt: new Date().toISOString(),
    ...extra,
  };
  writeJson(path, marker);
  return marker;
}

/** Record that onboarding finished — version + timestamp, plus any provenance the flow passes. */
export function markOnboarded(ooHome = defaultHome(), extra = {}) {
  ensureHome(ooHome);
  const marker = {
    ...readJson(join(ooHome, "onboarded.json")),
    version: ONBOARDING_VERSION,
    completed: [...ONBOARDING_STEPS],
    reviewedHarnesses: [...KNOWN_AGENT_HARNESSES],
    reviewedSessionHosts: [...REVIEWED_SESSION_HOSTS],
    sessionCatalogHash: SESSION_CATALOG_HASH,
    authVersion: AUTH_CONSENT_VERSION,
    at: new Date().toISOString(),
    ...extra,
  };
  writeJson(join(ooHome, "onboarded.json"), marker);
  return marker;
}

export function loadPiImportDecision(ooHome = defaultHome()) {
  const value = readJson(join(ooHome, "onboarded.json")).piImport;
  return value === "imported" || value === "declined" ? value : null;
}

/** Persist the standalone-Pi choice without completing model authorization. */
export function recordPiImportDecision(ooHome = defaultHome(), decision) {
  if (decision !== "imported" && decision !== "declined") throw new Error(`invalid Pi import decision "${decision}"`);
  ensureHome(ooHome);
  const path = join(ooHome, "onboarded.json");
  const marker = {
    ...readJson(path),
    version: ONBOARDING_VERSION,
    piImport: decision,
    updatedAt: new Date().toISOString(),
  };
  writeJson(path, marker);
  return decision;
}

const PI_MODEL_SETTING_KEYS = [
  "defaultProvider",
  "defaultModel",
  "defaultThinkingLevel",
  "transport",
  "enabledModels",
  "thinkingBudgets",
  "httpProxy",
  "httpIdleTimeoutMs",
  "websocketConnectTimeoutMs",
];

export function detectPiConfiguration(piAgentDir) {
  let selectedModel = false;
  let selectedProvider = null;
  let credentials = {};
  try { credentials = readRequiredObject(join(piAgentDir, "auth.json")); } catch { /* missing or invalid auth */ }
  try {
    const settings = readRequiredObject(join(piAgentDir, "settings.json"));
    selectedProvider = typeof settings.defaultProvider === "string" && settings.defaultProvider.trim()
      ? settings.defaultProvider.trim()
      : null;
    selectedModel = Boolean(selectedProvider) &&
      typeof settings.defaultModel === "string" && Boolean(settings.defaultModel.trim());
  } catch { /* missing or invalid settings */ }
  return {
    auth: Object.keys(credentials).length > 0,
    settings: existsSync(join(piAgentDir, "settings.json")),
    models: existsSync(join(piAgentDir, "models.json")),
    selectedModel,
    selectedModelAuthorized: selectedModel && Object.hasOwn(credentials, selectedProvider),
  };
}

function readRequiredObject(path) {
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`expected JSON object in ${path}`);
  return value;
}

export function importPiConfiguration(ooHome = defaultHome(), piAgentDir) {
  if (!piAgentDir) throw new Error("Pi agent directory is required");
  const paths = ensureOwnerOperatorWorkspace(ooHome);
  const detected = detectPiConfiguration(piAgentDir);
  if (detected.auth) {
    const source = readRequiredObject(join(piAgentDir, "auth.json"));
    writeJson(paths.piAuth, { ...readJson(paths.piAuth), ...source }, { mode: 0o600 });
    chmodSync(paths.piAuth, 0o600);
  }
  if (detected.settings) {
    const source = readRequiredObject(join(piAgentDir, "settings.json"));
    const modelSettings = Object.fromEntries(
      PI_MODEL_SETTING_KEYS.filter((key) => Object.hasOwn(source, key)).map((key) => [key, source[key]]),
    );
    writeJson(paths.piSettings, { ...readJson(paths.piSettings), ...modelSettings });
  }
  if (detected.models) {
    const source = readRequiredObject(join(piAgentDir, "models.json"));
    writeJson(paths.piModels, { ...readJson(paths.piModels), ...source });
  }
  const imports = readJson(paths.imports);
  writeJson(paths.imports, {
    ...imports,
    pi: { source: piAgentDir, importedAt: new Date().toISOString(), ...detected },
  });
  return { ...detected, source: piAgentDir };
}

/**
 * Add off-limits paths/repos to <ooHome>/blacklist.json, merged and de-duped with what's there.
 * Returns the resulting Blacklist. Empty/whitespace entries are dropped (loadBlacklist filters
 * them anyway); a call that adds nothing still touches the file so the flow can confirm it wrote.
 */
export function addBlacklistEntries(ooHome = defaultHome(), { paths = [], repos = [] } = {}) {
  ensureHome(ooHome);
  const clean = (xs) => uniq((Array.isArray(xs) ? xs : []).map((s) => String(s ?? "").trim()).filter(Boolean));
  const current = loadBlacklist(ooHome);
  const next = {
    paths: uniq([...current.paths, ...clean(paths).map((p) => p.replace(/\/+$/, ""))]),
    repos: uniq([...current.repos, ...clean(repos)]),
  };
  writeJson(join(ooHome, "blacklist.json"), next);
  return next;
}

/**
 * Point a known source at an extra root in <ooHome>/session_sources.json `add`. For the owner
 * whose sessions live off the beaten path (a relocated ~/.claude, an external drive). Throws on
 * an unknown source — a root with no parser would be dead config (see session-sources.mjs).
 */
export function addSessionRoot(ooHome = defaultHome(), source, root) {
  if (!KNOWN_SESSION_SOURCES.includes(source)) {
    throw new Error(`unknown session source "${source}" — one of: ${KNOWN_SESSION_SOURCES.join(", ")}`);
  }
  const trimmed = String(root ?? "").trim();
  if (!trimmed) throw new Error("session root path is required");
  ensureHome(ooHome);
  const path = join(ooHome, "session_sources.json");
  const cfg = readJson(path);
  const add = Array.isArray(cfg.add) ? cfg.add : [];
  if (!add.some((e) => e && e.source === source && e.root === trimmed)) add.push({ source, root: trimmed });
  writeJson(path, { ...cfg, add });
  return { source, root: trimmed };
}

/** Replace the configured scan aperture with exactly the roots the owner confirmed. */
export function saveSessionRoots(ooHome = defaultHome(), roots = []) {
  ensureHome(ooHome);
  const add = [];
  const seen = new Set();
  for (const entry of Array.isArray(roots) ? roots : []) {
    if (!KNOWN_SESSION_SOURCES.includes(entry?.source)) {
      throw new Error(`unknown session source "${entry?.source}" — one of: ${KNOWN_SESSION_SOURCES.join(", ")}`);
    }
    const root = String(entry?.root ?? "").trim();
    if (!root) throw new Error("session root path is required");
    const key = `${entry.source}\0${root}`;
    if (!seen.has(key)) add.push({ source: entry.source, root });
    seen.add(key);
  }
  const path = join(ooHome, "session_sources.json");
  writeJson(path, { ...readJson(path), disable: [...KNOWN_SESSION_SOURCES], add });
  return add;
}

/**
 * Persist one catalog review. Standard-root access and explicit relocated roots are independent,
 * so re-reviewing an older configuration cannot silently widen its aperture.
 */
export function saveTranscriptAccess(ooHome = defaultHome(), selectedFormats = [], roots = [], defaultFormats = selectedFormats) {
  const selected = uniq(Array.isArray(selectedFormats) ? selectedFormats : []);
  for (const format of selected) {
    if (!KNOWN_TRANSCRIPT_FORMATS.includes(format)) {
      throw new Error(`unknown transcript format "${format}" — one of: ${KNOWN_TRANSCRIPT_FORMATS.join(", ")}`);
    }
  }
  const enabled = new Set(selected);
  const enabledDefaults = new Set(uniq(Array.isArray(defaultFormats) ? defaultFormats : []));
  for (const format of enabledDefaults) {
    if (!KNOWN_TRANSCRIPT_FORMATS.includes(format)) {
      throw new Error(`unknown transcript format "${format}" — one of: ${KNOWN_TRANSCRIPT_FORMATS.join(", ")}`);
    }
    if (!enabled.has(format)) throw new Error(`standard roots require selected transcript format "${format}"`);
  }
  const add = [];
  const seen = new Set();
  for (const entry of Array.isArray(roots) ? roots : []) {
    const format = entry?.format ?? entry?.source;
    if (!enabled.has(format)) continue;
    const root = String(entry?.root ?? "").trim();
    if (!root) continue;
    const key = `${format}\0${root}`;
    if (!seen.has(key)) add.push({ source: format, root });
    seen.add(key);
  }
  ensureHome(ooHome);
  const path = join(ooHome, "session_sources.json");
  writeJson(path, {
    ...readJson(path),
    disable: KNOWN_TRANSCRIPT_FORMATS.filter((format) => !enabledDefaults.has(format)),
    add,
  });
  return { selected, add };
}

/** Persist roots used only to attribute sessions to their owner-facing host. */
export function saveSessionHostRoots(ooHome = defaultHome(), roots = []) {
  const clean = [];
  const seen = new Set();
  for (const entry of Array.isArray(roots) ? roots : []) {
    if (!KNOWN_SESSION_HOSTS.includes(entry?.host)) {
      throw new Error(`unknown session host "${entry?.host}" — one of: ${KNOWN_SESSION_HOSTS.join(", ")}`);
    }
    const root = String(entry?.root ?? "").trim();
    if (!root) throw new Error("session host root path is required");
    const key = `${entry.host}\0${root}`;
    if (!seen.has(key)) clean.push({ host: entry.host, root });
    seen.add(key);
  }
  ensureHome(ooHome);
  const path = join(ooHome, "session_hosts.json");
  writeJson(path, { ...readJson(path), roots: clean });
  return clean;
}

/** Skip a default source's roots via <ooHome>/session_sources.json `disable`. Merged, de-duped. */
export function disableSessionSource(ooHome = defaultHome(), source) {
  ensureHome(ooHome);
  const path = join(ooHome, "session_sources.json");
  const cfg = readJson(path);
  const disable = uniq([...(Array.isArray(cfg.disable) ? cfg.disable : []), source].filter((s) => typeof s === "string"));
  writeJson(path, { ...cfg, disable });
  return disable;
}

/**
 * Set the active-thread window in <ooHome>/settings.json (merging other keys). Validates against
 * the shared window grammar so onboarding rejects a typo before it's written — the loader would
 * silently fall back to the default, hiding the mistake. Throws on an unparseable spec.
 */
export function saveActiveWindow(ooHome = defaultHome(), spec) {
  const s = String(spec ?? "").trim();
  if (!isWindowSpec(s)) throw new Error(`invalid active window "${spec}" — use Nh, Nd, today, or YYYY-MM-DD`);
  ensureHome(ooHome);
  const path = join(ooHome, "settings.json");
  writeJson(path, { ...readJson(path), activeWindow: s });
  return s;
}

export {
  detectSessionSourceCandidates,
  detectSources,
  summarizeDetectedSources,
} from "./source-detection.mjs";
export { detectSessionHostCandidates } from "./host-detection.mjs";
