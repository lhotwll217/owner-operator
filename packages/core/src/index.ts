// Owner Operator — shared domain model.
//
// UI-INDEPENDENT by design: the gateway *produces* this data; every surface (widget,
// terminal, web, another agent, a script) *consumes* it. No colors, no layout, no terminal, no
// engine deps. This is the contract the daemon and all renderers agree on.

// The privacy blacklist: repos/paths the owner declared off-limits — enforced at the
// scan (discovery), the store seam (writes), and the open-time purge. See blacklist.mjs.
export { loadBlacklist, isBlacklisted, pathSlugs } from "./blacklist.mjs";
export type { Blacklist } from "./blacklist.mjs";

// Where local agent sessions live — the (source, root) dirs the scan and poller share, with
// owner overrides from session_sources.json. One source of truth so they can't drift.
export { loadSessionSources, KNOWN_SESSION_SOURCES } from "./session-sources.mjs";
export type { SessionSource, SessionRoot } from "./session-sources.mjs";

// Interactive GUI hosts (Conductor/Superset drive the SDK, PostHog Code ACP) — the single
// source of truth that keeps a deliberately-launched session from being hidden as an SDK
// worker. Read by the scan's launch-mode classifier and app detection. See gui-hosts.mjs.
export { loadGuiHosts, guiHostForCwd, interactiveHost } from "./gui-hosts.mjs";
export type { GuiHost } from "./gui-hosts.mjs";

// Owner settings — scalar knobs (today the active-thread window) from settings.json, later set
// in onboarding. The window grammar (parseWindowMs) is shared so the scan's cutoff and the
// settings validator can't drift. See settings.mjs.
export { loadActiveWindow, parseWindowMs, isWindowSpec, DEFAULT_ACTIVE_WINDOW } from "./settings.mjs";

// Thread status & the lo-fi state machine — model-free, polled, persisted. See status.ts.
export * from "./status";

// Session-state data model: digest metadata + live status (+ cached triage), with the
// default-visible filter and grouping all surfaces share. See session-state.ts.
export * from "./session-state";

// The daemon wire protocol: endpoints, schedules/triggers, and push events — the contract
// every surface speaks to the one state-owning process. See protocol.ts.
export * from "./protocol";
