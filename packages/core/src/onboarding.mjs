// Owner Operator — first-run onboarding state. The config loaders (blacklist, session-sources,
// settings) only READ; the guided setup flow needs to WRITE the same files, plus a marker so it
// runs once. This is that write half — and the source DETECTION the flow shows ("found Claude ✓,
// Codex ✓") before it scans for real. Kept beside the loaders so the two never drift on shape.
//
// Writers merge, never clobber: re-running onboarding adds to blacklist.json / session_sources.json
// rather than wiping an owner's hand-edits. Detection reuses loadSessionSources so it honors the
// same overrides the scan will. Plain ESM (not TS) so the zero-install scan skill can import it
// (re-exported via @owner-operator/core). Types: onboarding.d.mts.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadBlacklist } from "./blacklist.mjs";
import { loadSessionSources, KNOWN_SESSION_SOURCES } from "./session-sources.mjs";
import { isWindowSpec } from "./settings.mjs";

// Bumped when the flow gains a step the owner must be re-walked through. isOnboarded() only
// checks presence, so a bump today just records provenance; a future flow can gate on it.
export const ONBOARDING_VERSION = 1;

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

/** True once the guided setup has completed at least once (marker at <ooHome>/onboarded.json). */
export function isOnboarded(ooHome = defaultHome()) {
  const m = readJson(join(ooHome, "onboarded.json"));
  return typeof m.version === "number";
}

/** Record that onboarding finished — version + timestamp, plus any provenance the flow passes. */
export function markOnboarded(ooHome = defaultHome(), extra = {}) {
  ensureHome(ooHome);
  const marker = { version: ONBOARDING_VERSION, at: new Date().toISOString(), ...extra };
  writeJson(join(ooHome, "onboarded.json"), marker);
  return marker;
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
      if (e.name.endsWith(".jsonl") || e.name.endsWith(".json")) count++;
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
