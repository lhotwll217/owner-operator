// Owner Operator — agent harnesses and their transcript stores. The catalog is owner-facing
// harness identity plus the transcript format and store-discovery metadata needed to support it.
// The scan and monitor consume transcript stores; legacy "session source" exports remain adapters
// for persisted config and the vendored session-search contract.
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
 * Supported agent harnesses. Adding one requires a transcript-format implementation; call
 * assertTranscriptFormatCoverage() at that implementation boundary so an incomplete addition
 * fails loudly instead of becoming dead config.
 */
export const AGENT_HARNESS_DESCRIPTORS = Object.freeze([
  {
    id: "claude-code",
    label: "Claude Code",
    transcriptFormat: "claude",
    defaults: [[".claude", "projects"]],
    common: [[".config", "claude", "projects"]],
    declared: [{ env: "CLAUDE_CONFIG_DIR", suffix: ["projects"] }],
    deep: [{ marker: ".claude", suffix: ["projects"] }],
  },
  {
    id: "codex",
    label: "Codex",
    transcriptFormat: "codex",
    defaults: [[".codex", "sessions"]],
    common: [[".config", "codex", "sessions"]],
    declared: [{ env: "CODEX_HOME", suffix: ["sessions"] }],
    deep: [{ marker: ".codex", suffix: ["sessions"] }],
  },
  {
    id: "cursor-agent",
    label: "Cursor Agent",
    transcriptFormat: "cursor",
    defaults: [[".cursor", "projects"]],
    common: [],
    declared: [{ env: "CURSOR_HOME", suffix: ["projects"] }],
    deep: [{ marker: ".cursor", suffix: ["projects"] }],
  },
  {
    id: "posthog-code",
    label: "PostHog Code",
    transcriptFormat: "posthog-code",
    defaults: [[".posthog-code", "sessions"]],
    common: [],
    declared: [{ env: "POSTHOG_CODE_HOME", suffix: ["sessions"] }],
    deep: [{ marker: ".posthog-code", suffix: ["sessions"] }],
  },
  {
    id: "pi",
    label: "Pi",
    transcriptFormat: "pi",
    defaults: [[".pi", "agent", "sessions"]],
    common: [[".config", "pi", "agent", "sessions"]],
    declared: [{ env: "PI_CODING_AGENT_DIR", suffix: ["sessions"] }],
    deep: [{ marker: ".pi", suffix: ["agent", "sessions"] }],
  },
  {
    id: "opencode",
    label: "OpenCode",
    transcriptFormat: "opencode",
    defaults: [[".local", "share", "opencode", "storage"]],
    common: [],
    declared: [
      { env: "OPENCODE_HOME", suffix: ["storage"] },
      { env: "XDG_DATA_HOME", suffix: ["opencode", "storage"] },
    ],
    deep: [{ marker: "opencode", suffix: ["storage"] }],
  },
  {
    id: "antigravity",
    label: "Antigravity",
    transcriptFormat: "antigravity",
    defaults: [[".gemini", "antigravity"], [".gemini", "antigravity-cli"]],
    common: [],
    declared: [{ env: "GEMINI_HOME", suffix: ["antigravity"] }],
    deep: [
      { marker: ".gemini", suffix: ["antigravity"] },
      { marker: ".gemini", suffix: ["antigravity-cli"] },
    ],
  },
  {
    id: "grok-build",
    label: "Grok Build",
    transcriptFormat: "grok-build",
    defaults: [[".grok", "sessions"]],
    common: [],
    declared: [{ env: "GROK_HOME", suffix: ["sessions"] }],
    deep: [{ marker: ".grok", suffix: ["sessions"] }],
  },
]);

export const KNOWN_AGENT_HARNESSES = Object.freeze(AGENT_HARNESS_DESCRIPTORS.map(({ id }) => id));
export const KNOWN_TRANSCRIPT_FORMATS = Object.freeze([...new Set(AGENT_HARNESS_DESCRIPTORS.map(({ transcriptFormat }) => transcriptFormat))]);

// Compatibility view: persisted session_sources.json and session-grep call the transcript-format
// discriminator `source`. New domain code uses AGENT_HARNESS_DESCRIPTORS/loadTranscriptStores.
export const SESSION_SOURCE_DESCRIPTORS = Object.freeze(AGENT_HARNESS_DESCRIPTORS.map((descriptor) => ({
  source: descriptor.transcriptFormat,
  defaults: descriptor.defaults,
  common: descriptor.common,
  declared: descriptor.declared,
  deep: descriptor.deep,
})));
export const KNOWN_SESSION_SOURCES = KNOWN_TRANSCRIPT_FORMATS;

export function assertTranscriptFormatCoverage(implementedFormats) {
  const implemented = new Set(Array.isArray(implementedFormats) ? implementedFormats : [...(implementedFormats ?? [])]);
  const expected = new Set(KNOWN_TRANSCRIPT_FORMATS);
  const missing = KNOWN_TRANSCRIPT_FORMATS.filter((format) => !implemented.has(format));
  const unknown = [...implemented].filter((format) => !expected.has(format));
  if (missing.length || unknown.length) {
    throw new Error([
      missing.length ? `missing: ${missing.join(", ")}` : "",
      unknown.length ? `unknown: ${unknown.join(", ")}` : "",
    ].filter(Boolean).join("; "));
  }
}

function defaultRoots() {
  const home = homedir();
  return AGENT_HARNESS_DESCRIPTORS.flatMap(({ transcriptFormat, defaults, common }) =>
    [...defaults, ...common].map((parts) => ({ format: transcriptFormat, root: join(home, ...parts) })),
  );
}

const expand = (p) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

/**
 * The (source, root) dirs to scan/watch: built-in defaults minus `disable`, plus `add`.
 * Missing or invalid config → defaults only (never throws). ooHome defaults to
 * $OO_HOME or ~/.owner-operator so callers that don't track it (the monitor) can omit it.
 */
export function loadTranscriptStores(ooHome = process.env.OO_HOME ?? join(homedir(), ".owner-operator")) {
  let cfg = {};
  try { cfg = JSON.parse(readFileSync(join(ooHome, "session_sources.json"), "utf8")) || {}; } catch { /* missing/invalid → defaults */ }

  const disable = new Set((Array.isArray(cfg.disable) ? cfg.disable : []).filter((s) => typeof s === "string"));
  const roots = defaultRoots().filter((store) => !disable.has(store.format));

  for (const e of Array.isArray(cfg.add) ? cfg.add : []) {
    const format = e?.format ?? e?.source;
    // Skip entries for formats we can't parse — a root with no parser would just be dead config.
    if (KNOWN_TRANSCRIPT_FORMATS.includes(format) && typeof e.root === "string" && e.root.trim()) {
      roots.push({ format, root: expand(e.root.trim()) });
    }
  }

  // Collapse identical (source, root) pairs (e.g. an `add` that restates a default).
  const seen = new Set();
  return roots.filter((store) => {
    const key = `${store.format}\0${store.root}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Effective harness-format access plus whether each format's standard roots are authorized. */
export function loadTranscriptAccess(ooHome = process.env.OO_HOME ?? join(homedir(), ".owner-operator")) {
  let config = {};
  try { config = JSON.parse(readFileSync(join(ooHome, "session_sources.json"), "utf8")) || {}; } catch { /* defaults */ }
  const disabledDefaults = new Set((Array.isArray(config.disable) ? config.disable : []).filter((format) => typeof format === "string"));
  return {
    selectedFormats: [...new Set(loadTranscriptStores(ooHome).map(({ format }) => format))],
    defaultFormats: KNOWN_TRANSCRIPT_FORMATS.filter((format) => !disabledDefaults.has(format)),
  };
}

/** Compatibility loader for callers and config that still name a transcript format `source`. */
export function loadSessionSources(ooHome = process.env.OO_HOME ?? join(homedir(), ".owner-operator")) {
  return loadTranscriptStores(ooHome).map(({ format, root }) => ({ source: format, root }));
}
