// Owner Operator — where local agent sessions live. The scan and session monitor both need the
// same list of (source, root) dirs; this is the single source of truth so they can't drift.
//
// Built-in defaults cover the tools we parse. An owner whose sessions live elsewhere (a
// relocated ~/.claude, a second PostHog Code dir, sessions on an external drive) overrides
// via <ooHome>/session_sources.json:
//
//   {
//     "disable": ["cursor"],                                  // skip a default source's roots
//     "add": [
//       { "source": "posthog-code", "root": "/work/ph/sessions" },
//       { "source": "claude",       "root": "~/alt/claude" }  // ~/ expands to $HOME
//     ]
//   }
//
// `source` MUST be one of KNOWN_SESSION_SOURCES — parsing each format is code (see
// scan-active-transcripts.mjs), so config can point at a NEW LOCATION, not teach a new format.
// To relocate a source, `disable` its default and `add` the new root. Plain ESM (not TS) so
// the zero-install scan skill runs the exact code the gateway uses (re-exported via
// @owner-operator/core). Types: session-sources.d.mts.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Source kinds the scan knows how to parse — THE source of truth for what's supported.
 * A root is only honored for one of these. Docs and skill descriptions point here instead
 * of naming sources; add a source here first.
 */
export const SESSION_SOURCE_DESCRIPTORS = Object.freeze([
  {
    source: "claude",
    defaults: [[".claude", "projects"]],
    common: [[".config", "claude", "projects"]],
    declared: [{ env: "CLAUDE_CONFIG_DIR", suffix: ["projects"] }],
    deep: [{ marker: ".claude", suffix: ["projects"] }],
  },
  {
    source: "codex",
    defaults: [[".codex", "sessions"]],
    common: [[".config", "codex", "sessions"]],
    declared: [{ env: "CODEX_HOME", suffix: ["sessions"] }],
    deep: [{ marker: ".codex", suffix: ["sessions"] }],
  },
  {
    source: "cursor",
    defaults: [[".cursor", "projects"]],
    common: [],
    declared: [{ env: "CURSOR_HOME", suffix: ["projects"] }],
    deep: [{ marker: ".cursor", suffix: ["projects"] }],
  },
  {
    source: "posthog-code",
    defaults: [[".posthog-code", "sessions"]],
    common: [],
    declared: [{ env: "POSTHOG_CODE_HOME", suffix: ["sessions"] }],
    deep: [{ marker: ".posthog-code", suffix: ["sessions"] }],
  },
  {
    source: "pi",
    defaults: [[".pi", "agent", "sessions"]],
    common: [[".config", "pi", "agent", "sessions"]],
    declared: [{ env: "PI_CODING_AGENT_DIR", suffix: ["sessions"] }],
    deep: [{ marker: ".pi", suffix: ["agent", "sessions"] }],
  },
  {
    source: "opencode",
    defaults: [[".local", "share", "opencode", "storage"]],
    common: [],
    declared: [
      { env: "OPENCODE_HOME", suffix: ["storage"] },
      { env: "XDG_DATA_HOME", suffix: ["opencode", "storage"] },
    ],
    deep: [{ marker: "opencode", suffix: ["storage"] }],
  },
  {
    source: "antigravity",
    defaults: [[".gemini", "antigravity"], [".gemini", "antigravity-cli"]],
    common: [],
    declared: [{ env: "GEMINI_HOME", suffix: ["antigravity"] }],
    deep: [
      { marker: ".gemini", suffix: ["antigravity"] },
      { marker: ".gemini", suffix: ["antigravity-cli"] },
    ],
  },
  {
    source: "grok-build",
    defaults: [[".grok", "sessions"]],
    common: [],
    declared: [{ env: "GROK_HOME", suffix: ["sessions"] }],
    deep: [{ marker: ".grok", suffix: ["sessions"] }],
  },
]);

export const KNOWN_SESSION_SOURCES = Object.freeze(SESSION_SOURCE_DESCRIPTORS.map(({ source }) => source));

function defaultRoots() {
  const home = homedir();
  return SESSION_SOURCE_DESCRIPTORS.flatMap(({ source, defaults }) =>
    defaults.map((parts) => ({ source, root: join(home, ...parts) })),
  );
}

const expand = (p) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

/**
 * The (source, root) dirs to scan/watch: built-in defaults minus `disable`, plus `add`.
 * Missing or invalid config → defaults only (never throws). ooHome defaults to
 * $OO_HOME or ~/.owner-operator so callers that don't track it (the monitor) can omit it.
 */
export function loadSessionSources(ooHome = process.env.OO_HOME ?? join(homedir(), ".owner-operator")) {
  let cfg = {};
  try { cfg = JSON.parse(readFileSync(join(ooHome, "session_sources.json"), "utf8")) || {}; } catch { /* missing/invalid → defaults */ }

  const disable = new Set((Array.isArray(cfg.disable) ? cfg.disable : []).filter((s) => typeof s === "string"));
  const roots = defaultRoots().filter((r) => !disable.has(r.source));

  for (const e of Array.isArray(cfg.add) ? cfg.add : []) {
    // Skip entries for sources we can't parse — a root with no parser would just be dead config.
    if (e && KNOWN_SESSION_SOURCES.includes(e.source) && typeof e.root === "string" && e.root.trim()) {
      roots.push({ source: e.source, root: expand(e.root.trim()) });
    }
  }

  // Collapse identical (source, root) pairs (e.g. an `add` that restates a default).
  const seen = new Set();
  return roots.filter((r) => { const k = `${r.source}\0${r.root}`; if (seen.has(k)) return false; seen.add(k); return true; });
}
