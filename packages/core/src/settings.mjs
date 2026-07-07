// Owner Operator — owner settings. The scalar knobs the owner tunes (today via this config
// file, later in onboarding — see ROADMAP). Distinct from the structural config files
// (session_sources.json, blacklist.json, gui_hosts.json), which carry lists; this carries the
// dials. Read from <ooHome>/settings.json; a missing file / invalid JSON / bad value → the
// documented default (never throws):
//
//   { "activeWindow": "36h" }   // how far back "active" looks — session-state inclusion
//
// Plain ESM (not TS) so the zero-install scan skill runs the exact code the gateway uses
// (re-exported via @owner-operator/core). Types: settings.d.mts.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// The default lookback for "active": a rolling 24h — NOT calendar-"today". A thread last
// touched at 11pm is still active at 9am the next morning; a midnight boundary would hide it.
export const DEFAULT_ACTIVE_WINDOW = "1d";

/**
 * Resolve a window spec to a cutoff timestamp (ms): a rolling duration — `Nh` (hours) or `Nd`
 * (days) — the calendar-day `today` (local midnight), or an ISO date (`YYYY-MM-DD`). Returns
 * null for an unparseable spec so callers fall back. `nowMs` is injected so it stays pure and
 * testable. This is the ONE window grammar — the scan's cutoff and the settings validator both
 * call it, so an accepted setting always parses at scan time (no drift).
 */
export function parseWindowMs(spec, nowMs) {
  if (typeof spec !== "string") return null;
  const s = spec.trim();
  if (s === "today") { const d = new Date(nowMs); d.setHours(0, 0, 0, 0); return d.getTime(); }
  const h = /^(\d+)h$/.exec(s); if (h) return nowMs - parseInt(h[1], 10) * 3600000;
  const d = /^(\d+)d$/.exec(s); if (d) return nowMs - parseInt(d[1], 10) * 86400000;
  const date = new Date(s + "T00:00:00"); if (!isNaN(date.getTime())) return date.getTime();
  return null;
}

/** True if `spec` is a window the scan understands — so the loader (and onboarding) reject typos. */
export function isWindowSpec(spec) {
  return parseWindowMs(spec, 0) != null;
}

/**
 * The owner's active-thread window (a `--since` spec) from <ooHome>/settings.json `activeWindow`.
 * A missing file, invalid JSON, or an unparseable value → DEFAULT_ACTIVE_WINDOW. Never throws.
 * ooHome defaults to $OO_HOME or ~/.owner-operator so callers that don't track it can omit it.
 */
export function loadActiveWindow(ooHome = process.env.OO_HOME ?? join(homedir(), ".owner-operator")) {
  try {
    const cfg = JSON.parse(readFileSync(join(ooHome, "settings.json"), "utf8")) || {};
    if (typeof cfg.activeWindow === "string" && isWindowSpec(cfg.activeWindow)) return cfg.activeWindow.trim();
  } catch { /* missing/invalid → default */ }
  return DEFAULT_ACTIVE_WINDOW;
}
