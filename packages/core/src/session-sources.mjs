// Owner Operator — where local agent sessions live. The scan and the poller both need the
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
// the zero-install scan skill runs the exact code the harness uses (re-exported via
// @owner-operator/core). Types: session-sources.d.mts.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Source kinds the scan knows how to parse — THE source of truth for what's supported.
 * A root is only honored for one of these. Docs and skill descriptions point here instead
 * of naming sources; add a source here first.
 */
export const KNOWN_SESSION_SOURCES = ["claude", "codex", "cursor", "posthog-code", "pi", "opencode", "antigravity", "grok-build"];

function defaultRoots() {
  const home = homedir();
  return [
    { source: "claude", root: join(home, ".claude", "projects") },
    { source: "codex", root: join(home, ".codex", "sessions") },
    { source: "cursor", root: join(home, ".cursor", "projects") },
    { source: "posthog-code", root: join(home, ".posthog-code", "sessions") },
    { source: "pi", root: join(home, ".pi", "agent", "sessions") },
    // opencode keeps ~/.local/share on macOS too (no Application Support split).
    { source: "opencode", root: join(home, ".local", "share", "opencode", "storage") },
    // Antigravity writes brain transcripts under ~/.gemini — the IDE and the CLI each get a dir.
    { source: "antigravity", root: join(home, ".gemini", "antigravity") },
    { source: "antigravity", root: join(home, ".gemini", "antigravity-cli") },
    { source: "grok-build", root: join(home, ".grok", "sessions") },
  ];
}

const expand = (p) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

/**
 * The (source, root) dirs to scan/watch: built-in defaults minus `disable`, plus `add`.
 * Missing or invalid config → defaults only (never throws). ooHome defaults to
 * $OO_HOME or ~/.owner-operator so callers that don't track it (the poller) can omit it.
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
