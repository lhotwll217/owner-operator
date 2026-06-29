// Owner Operator — shared domain model.
//
// UI-INDEPENDENT by design: the harness *produces* this data; every surface (TUI, web,
// widget, another agent, a script) *consumes* it. No colors, no layout, no terminal, no
// engine deps. This is the contract the headless output and all renderers agree on — the
// "structured data is the product; UIs are renderers" split the pi ecosystem uses.

/** One active agent thread, triaged. The headless unit of data every surface renders. */
export interface Thread {
  /** Stable session id (from the scan digest). Joins triage ↔ the live status poll. */
  id?: string;
  /** Short title of what the thread is about. */
  topic: string;
  /** 5 (highest — needs the owner now) down to 1 (lowest). */
  priority: number;
  /** One sentence on what has generally happened / current state. */
  summary: string;
  /** One short clause: the concrete next action. */
  nextSteps: string;
  /** Repo name. */
  repo: string;
  /** App / GUI the session was made from. */
  app: string;
  /** Relative time created, e.g. "2 hours ago". */
  created: string;
  /** Relative time of the last message, e.g. "just now". */
  lastActive: string;
  /** Workspace git line delta (copied from the digest's Diff line when present). */
  diffAdded?: number;
  diffDeleted?: number;
  /** Deep link to open the session, if known. */
  link?: string;
}

/** A full triage snapshot: the active threads. Most-urgent first by convention. */
export type Triage = Thread[];

/** Order threads loudest-first (priority 5 → 1). Pure, so every surface shares one ordering. */
export function sortByPriority(threads: readonly Thread[]): Thread[] {
  return [...threads].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
}

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

// Thread status & the lo-fi state machine — model-free, polled, persisted. The cheap
// counterpart to the triaged `Thread` above (which needs the model). See status.ts.
export * from "./status";

// The sidebar data model: digest metadata + live status (+ cached triage), with the
// default-visible filter and grouping the sidebar renders. See sidebar.ts.
export * from "./sidebar";

// The daemon wire protocol: endpoints, schedules/triggers, and push events — the contract
// every surface speaks to the one state-owning process. See protocol.ts.
export * from "./protocol";
