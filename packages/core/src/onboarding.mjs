// Owner Operator — first-run onboarding state. The config loaders (blacklist, session-sources,
// settings) only READ; the guided setup flow needs to WRITE the same files, plus a marker so it
// runs once. This is that write half; source-detection.mjs owns the bounded discovery read side.
//
// Additive writers merge and de-duplicate. The confirmed source-aperture writer replaces only its
// `disable`/`add` fields so re-running setup can remove consent. Plain ESM (not TS) lets the
// zero-install scan skill import the same API. Types: onboarding.d.mts.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadBlacklist } from "./blacklist.mjs";
import { KNOWN_SESSION_SOURCES } from "./session-sources.mjs";
import { isWindowSpec } from "./settings.mjs";
import { ensureOwnerOperatorWorkspace } from "./harness.mjs";

// Bumped when the flow gains a step the owner must be re-walked through. isOnboarded() only
// checks presence, so a bump today just records provenance; a future flow can gate on it.
export const ONBOARDING_VERSION = 2;
export const ONBOARDING_STEPS = Object.freeze([
  "intro",
  "privacy",
  "auth",
  "session-sources",
  "active-window",
  "skills",
  "always-on",
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

export function pendingOnboardingSteps(ooHome = defaultHome()) {
  const marker = readJson(join(ooHome, "onboarded.json"));
  const completed = new Set(Array.isArray(marker.completed) ? marker.completed : []);
  return ONBOARDING_STEPS.filter((step) => !completed.has(step));
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
    at: new Date().toISOString(),
    ...extra,
  };
  writeJson(join(ooHome, "onboarded.json"), marker);
  return marker;
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
  return {
    auth: existsSync(join(piAgentDir, "auth.json")),
    settings: existsSync(join(piAgentDir, "settings.json")),
    models: existsSync(join(piAgentDir, "models.json")),
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
