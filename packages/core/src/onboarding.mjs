// Owner Operator — first-run onboarding state. The config loaders (blacklist, session-sources,
// settings) only READ; the guided setup flow needs to WRITE the same files, plus a marker so it
// runs once. This is that write half — and the source DETECTION the flow shows ("found Claude ✓,
// Codex ✓") before it scans for real. Kept beside the loaders so the two never drift on shape.
//
// Additive writers merge and de-duplicate. The confirmed source-aperture writer replaces only its
// `disable`/`add` fields so re-running setup can remove consent. Detection reuses
// loadSessionSources, so configured roots match the scan. Plain ESM (not TS) lets the zero-install
// scan skill import the same API (re-exported via @owner-operator/core). Types: onboarding.d.mts.

import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isBlacklisted, loadBlacklist } from "./blacklist.mjs";
import { loadSessionSources, KNOWN_SESSION_SOURCES } from "./session-sources.mjs";
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
function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
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
    writeJson(paths.piAuth, { ...readJson(paths.piAuth), ...source });
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

// Count session-ish files under a root without reading them — a bounded recursive walk (depth and
// total capped) so a huge ~/.claude can't stall the flow. `.jsonl`/`.json` covers every source we
// parse; the number is a rough "is there activity here" signal for the confirm screen, not the
// authoritative count (the daemon scan produces that when it ranks for real).
function countSessions(root, { cap = 500, maxDepth = 6 } = {}) {
  let exists = false;
  let count = 0;
  const walk = (dir, depth) => {
    if (count >= cap || depth > maxDepth) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    exists = true;
    for (const e of entries) {
      if (count >= cap) return;
      if (e.isDirectory()) { walk(join(dir, e.name), depth + 1); continue; }
    if (e.name.endsWith(".jsonl") || e.name.endsWith(".ndjson") || e.name.endsWith(".json")) count++;
    }
  };
  walk(root, 0);
  return { exists, count };
}

/**
 * Probe every configured (source, root) for existing sessions — the data the flow shows before
 * it commits ("Claude ✓ 12 · Codex ✓ 3 · Cursor · none"). Honors session_sources.json overrides
 * (it calls loadSessionSources), so what's detected is exactly what the scan will later read.
 */
export function detectSources(ooHome = defaultHome(), opts = {}) {
  return loadSessionSources(ooHome).map(({ source, root }) => ({ source, root, ...countSessions(root, opts) }));
}

/**
 * Collapse detectSources() rows to one per source (a source can have several roots, e.g.
 * antigravity) — the per-tool summary the confirm screen lists.
 */
export function summarizeDetectedSources(detected) {
  const by = new Map();
  for (const { source, root, exists, count } of detected) {
    const acc = by.get(source) ?? { source, roots: [], exists: false, count: 0 };
    acc.roots.push(root);
    acc.exists ||= exists;
    acc.count += count;
    by.set(source, acc);
  }
  return [...by.values()];
}

const DEFAULT_SOURCE_ROOTS = [
  ["claude", [".claude", "projects"]],
  ["codex", [".codex", "sessions"]],
  ["cursor", [".cursor", "projects"]],
  ["posthog-code", [".posthog-code", "sessions"]],
  ["pi", [".pi", "agent", "sessions"]],
  ["opencode", [".local", "share", "opencode", "storage"]],
  ["antigravity", [".gemini", "antigravity"]],
  ["antigravity", [".gemini", "antigravity-cli"]],
  ["grok-build", [".grok", "sessions"]],
];
const COMMON_SOURCE_ROOTS = [
  ["claude", [".config", "claude", "projects"]],
  ["codex", [".config", "codex", "sessions"]],
  ["pi", [".config", "pi", "agent", "sessions"]],
];
const DECLARED_ROOTS = [
  ["CLAUDE_CONFIG_DIR", "claude", ["projects"]],
  ["CODEX_HOME", "codex", ["sessions"]],
  ["CURSOR_HOME", "cursor", ["projects"]],
  ["POSTHOG_CODE_HOME", "posthog-code", ["sessions"]],
  ["PI_CODING_AGENT_DIR", "pi", ["sessions"]],
  ["OPENCODE_HOME", "opencode", ["storage"]],
  ["GEMINI_HOME", "antigravity", ["antigravity"]],
  ["GROK_HOME", "grok-build", ["sessions"]],
];
const DEEP_MARKERS = new Map([
  [".claude", [["claude", ["projects"]]]],
  [".codex", [["codex", ["sessions"]]]],
  [".cursor", [["cursor", ["projects"]]]],
  [".posthog-code", [["posthog-code", ["sessions"]]]],
  [".pi", [["pi", ["agent", "sessions"]]]],
  ["opencode", [["opencode", ["storage"]]]],
  [".gemini", [["antigravity", ["antigravity"]], ["antigravity", ["antigravity-cli"]]]],
  [".grok", [["grok-build", ["sessions"]]]],
]);
const PRUNED_NAMES = new Set([".git", "node_modules", "Caches", "CloudStorage", "Mobile Documents", "iCloud Drive"]);

function sourceCandidate(source, root, tier) {
  const counted = countSessions(root, { cap: 1, maxDepth: 3 });
  return { source, root, tier, exists: counted.exists, shape: counted.count > 0 };
}

function mountedVolumes() {
  if (process.platform !== "darwin") return [];
  try {
    return readdirSync("/Volumes", { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join("/Volumes", entry.name));
  } catch {
    return [];
  }
}

/** Detect candidate roots without configuring them. Tier 3 is opt-in and bounded. */
export function detectSessionSourceCandidates(ooHome = defaultHome(), options = {}) {
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const candidates = [];
  const add = (source, root, tier) => {
    if (KNOWN_SESSION_SOURCES.includes(source) && typeof root === "string" && root.trim()) {
      candidates.push(sourceCandidate(source, resolve(root), tier));
    }
  };

  const configured = readJson(join(ooHome, "session_sources.json"));
  for (const entry of Array.isArray(configured.add) ? configured.add : []) add(entry?.source, entry?.root, 1);
  for (const [name, source, suffix] of DECLARED_ROOTS) {
    if (typeof env[name] === "string" && env[name].trim()) add(source, join(env[name], ...suffix), 1);
  }
  const piAgentDir = typeof env.PI_CODING_AGENT_DIR === "string" && env.PI_CODING_AGENT_DIR.trim()
    ? resolve(env.PI_CODING_AGENT_DIR)
    : join(home, ".pi", "agent");
  const piSettings = readJson(join(piAgentDir, "settings.json"));
  if (typeof piSettings.sessionDir === "string" && piSettings.sessionDir.trim()) {
    const value = piSettings.sessionDir.trim();
    add("pi", value === "~" ? home : value.startsWith("~/") ? join(home, value.slice(2)) : resolve(piAgentDir, value), 1);
  }
  if (typeof env.PI_CODING_AGENT_SESSION_DIR === "string" && env.PI_CODING_AGENT_SESSION_DIR.trim()) {
    add("pi", resolve(env.PI_CODING_AGENT_SESSION_DIR), 1);
  }
  if (typeof env.XDG_DATA_HOME === "string" && env.XDG_DATA_HOME.trim()) {
    add("opencode", join(env.XDG_DATA_HOME, "opencode", "storage"), 1);
  }

  const disabled = new Set(Array.isArray(configured.disable) ? configured.disable : []);
  for (const [source, parts] of [...DEFAULT_SOURCE_ROOTS, ...COMMON_SOURCE_ROOTS]) {
    if (!disabled.has(source)) add(source, join(home, ...parts), 2);
  }

  if (options.deep) {
    const blacklist = loadBlacklist(ooHome);
    const deadline = Date.now() + Math.max(1, options.timeoutMs ?? 2_000);
    const maxDepth = Math.max(1, options.maxDepth ?? 5);
    const roots = [home, ...(options.volumes ?? mountedVolumes())];
    const walk = (dir, depth) => {
      if (depth > maxDepth || Date.now() >= deadline) return;
      if (isBlacklisted(blacklist, { cwd: dir })) return;
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (Date.now() >= deadline) return;
        if (!entry.isDirectory() || PRUNED_NAMES.has(entry.name)) continue;
        const path = join(dir, entry.name);
        if (isBlacklisted(blacklist, { cwd: path })) continue;
        const matches = DEEP_MARKERS.get(entry.name) ?? [];
        for (const [source, suffix] of matches) {
          const candidate = sourceCandidate(source, join(path, ...suffix), 3);
          if (candidate.shape) candidates.push(candidate);
        }
        walk(path, depth + 1);
      }
    };
    for (const root of roots) walk(root, 0);
  }

  const seen = new Set();
  return candidates
    .sort((a, b) => a.tier - b.tier)
    .filter((candidate) => {
      const key = `${candidate.source}\0${candidate.root}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}
