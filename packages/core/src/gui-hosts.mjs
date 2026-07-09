// Owner Operator — interactive GUI hosts. A session can be LAUNCHED from a GUI that drives an
// agent over a non-interactive transport: Conductor and Superset open Claude/Codex via the
// SDK; PostHog Code runs over ACP. The launch-mode classifier (scan-active-transcripts.mjs) hides
// SDK/CLI single-turn workers by default — right for headless `claude -p` and Task subagents, but
// WRONG for these GUIs, whose sessions the owner opened deliberately. This is the single source
// of truth for "which hosts are interactive", read by both the classifier and detectUi, so a
// new GUI is ONE entry here — not a per-source patch scattered across the scan (the omission
// that silently hid every Conductor thread; see scan.integration.test.ts and gui-hosts.test.ts).
//
// A host matches a session by a cwd path marker (the GUI's worktree dir) and/or its source.
// `surfaceEmpty` hosts surface even with zero conversation (PostHog Code cloud tasks stream no
// turns while a sandbox provisions). Owner-extensible — a custom GUI / worktree layout — via
// <ooHome>/gui_hosts.json:
//
//   { "add": [{ "cwdMarker": "/myide/workspaces/", "ui": "My IDE" }] }
//
// Plain ESM (not TS) so the zero-install scan skill runs the exact code the gateway uses
// (re-exported via @owner-operator/core). Types: gui-hosts.d.mts.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Built-in hosts. cwdMarker hosts are matched before source hosts so a worktree wins (a Codex
// session living in a Conductor workspace IS Conductor, not Codex).
const BUILTIN_GUI_HOSTS = [
  { ui: "Superset App", cwdMarker: "/.superset/worktrees/" },
  { ui: "Conductor", cwdMarker: "/conductor/workspaces/" },
  { ui: "PostHog Code", source: "posthog-code", surfaceEmpty: true },
];

/**
 * The interactive GUI hosts: built-ins plus owner `add`s from <ooHome>/gui_hosts.json. Each
 * `add` needs a `ui` name and at least one matcher (`cwdMarker` or `source`); anything else is
 * dead config and dropped. Missing/invalid file → built-ins only (never throws). ooHome
 * defaults to $OO_HOME or ~/.owner-operator so callers that don't track it (the monitor) omit it.
 */
export function loadGuiHosts(ooHome = process.env.OO_HOME ?? join(homedir(), ".owner-operator")) {
  let cfg = {};
  try { cfg = JSON.parse(readFileSync(join(ooHome, "gui_hosts.json"), "utf8")) || {}; } catch { /* missing/invalid → built-ins */ }
  const hosts = [...BUILTIN_GUI_HOSTS];
  for (const e of Array.isArray(cfg.add) ? cfg.add : []) {
    const ui = typeof e?.ui === "string" ? e.ui.trim() : "";
    const cwdMarker = typeof e?.cwdMarker === "string" ? e.cwdMarker.trim() : "";
    const source = typeof e?.source === "string" ? e.source.trim() : "";
    if (!ui || (!cwdMarker && !source)) continue; // a host with no name or no matcher does nothing
    hosts.push({ ui, ...(cwdMarker ? { cwdMarker } : {}), ...(source ? { source } : {}), ...(e.surfaceEmpty ? { surfaceEmpty: true } : {}) });
  }
  return hosts;
}

/** The GUI a cwd physically lives in (path-marker hosts only), or null. Worktree → its GUI. */
export function guiHostForCwd(cwd, hosts = loadGuiHosts()) {
  if (!cwd) return null;
  return hosts.find((h) => h.cwdMarker && cwd.includes(h.cwdMarker)) ?? null;
}

/**
 * The interactive host for a session — matched by cwd path marker (worktree wins) or, failing
 * that, by source. null → no recognized GUI, so the launch-mode worker heuristics apply.
 */
export function interactiveHost(cwd, source, hosts = loadGuiHosts()) {
  return guiHostForCwd(cwd, hosts) ?? hosts.find((h) => h.source && h.source === source) ?? null;
}
