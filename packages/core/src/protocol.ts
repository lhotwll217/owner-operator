// Owner Operator — the daemon wire protocol. UI-INDEPENDENT: every surface (TUI today,
// web/widget tomorrow) speaks these shapes to the ONE process that owns state (the
// daemon, harness/src/daemon.ts — openclaw's gateway pattern).
//
// Transport: HTTP JSON on 127.0.0.1 + an SSE event stream — both zero-dependency on the
// node side and native in browsers (fetch/EventSource), so the web surface needs no SDK.
//
// Endpoints (strict command set, per docs/architecture.md):
//   GET  /health                    → { ok, pid, startedAt, polledAt }
//   GET  /snapshot                  → StatusSnapshot
//   GET  /triage                    → Record<threadId, TriageInfo>
//   GET  /events                    → SSE stream of DaemonEvent
//   POST /poll                      → StatusSnapshot           (force a reconcile pass)
//   POST /done      { ids }         → MarkThreadsDone result
//   POST /rename    { id, title }   → { ok }                   (owner title; "" clears → model titles resume)
//   POST /triage    { entries }     → { ok }                   (upsert triage cache)
//   GET  /schedules                 → Schedule[]
//   PUT  /schedules/:name           → Schedule                 (upsert by name)
//   DELETE /schedules/:name         → { ok }
//   POST /schedules/:name/run       → { ok, detail? }          (run now, regardless of when)

import type { StatusDiff, StatusSnapshot } from "./status";
import type { TriageInfo } from "./sidebar";

/** Default localhost port; override with OO_PORT. Clients discover the real one via daemon.json. */
export const DEFAULT_DAEMON_PORT = 47711;

/** Written next to the store (daemon.json) so clients find the live daemon; removed on exit. */
export interface DaemonInfo {
  port: number;
  pid: number;
  startedAt: string; // ISO
}

// ---- schedules & triggers ------------------------------------------------------------
// A schedule is WHEN × ACTION, upserted by name. Time-based schedules run from the
// daemon's tick loop; event schedules fire on state edges from the poll.

export type ScheduleWhen =
  | { type: "interval"; ms: number }       // every N ms (min 5s)
  | { type: "daily"; at: string }          // local "HH:MM" — e.g. the 08:00 morning brief
  | { type: "event"; event: "needs-you" }; // a thread newly needs the owner

export type ScheduleAction =
  | { type: "poll" }                       // force a reconcile pass
  // Run a user command (/bin/sh). Event runs get OO_NEEDS_YOU=<comma-separated ids> in the
  // env — enough for desktop notifications or piping a brief: `oo --json "what needs me"`.
  | { type: "shell"; command: string };

export interface Schedule {
  name: string;                            // the id — upsert key
  when: ScheduleWhen;
  action: ScheduleAction;
  enabled: boolean;
  lastRunAt?: string;                      // ISO
  lastResult?: { ok: boolean; detail?: string; at: string };
}

// ---- push events (the /events SSE stream) ---------------------------------------------

export type DaemonEvent =
  | { type: "snapshot"; snapshot: StatusSnapshot; diff: StatusDiff }
  | { type: "triage"; entries: Record<string, TriageInfo> }
  | { type: "schedule_run"; name: string; ok: boolean; detail?: string };
