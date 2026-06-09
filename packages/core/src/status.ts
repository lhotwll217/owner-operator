// Owner Operator — thread status & state machine.
//
// UI-INDEPENDENT and MODEL-FREE: everything here is derived from the cheap deterministic
// scan (lastRole + freshness), never the LLM. That's the split that lets the sidebar poll
// fast and for free — the expensive triage (priority/summary, see `Thread`) refreshes
// slowly and separately. Pure functions only, same contract every surface renders.

/**
 * Lifecycle state of a thread — lo-fi and distinct from `priority` (priority = how loud;
 * state = what's happening). Mirrors the bounded vocabulary agent-deck polls for.
 * `done` is reserved for the triage/diff layer (we can't observe "resolved" off disk yet).
 */
export type ThreadState = "needs-you" | "working" | "idle" | "done";

/** The subset of a raw scan row (`get-active-threads --json`) the state machine needs. */
export interface ScanRow {
  id: string;
  source: string;
  repo: string;
  /** App / GUI the session was made from (the scan's `ui`). */
  app: string;
  topic: string;
  /** Role of the last message — "user" | "assistant" | … */
  lastRole: string;
  createdAt: string;          // ISO
  lastMessageAt: string;      // ISO
  secondsSinceLastMessage: number;
  link?: string | null;
}

/** One polled thread with continuity across polls — the unit the sidebar renders. */
export interface ThreadStatus {
  id: string;
  source: string;
  repo: string;
  app: string;
  topic: string;
  state: ThreadState;
  /** Relative freshness for display, e.g. "7 minutes ago". */
  lastActive: string;
  createdAt: string;          // ISO
  lastMessageAt: string;      // ISO
  /** ISO of the first poll that saw this thread. */
  firstSeen: string;
  /** ISO of when it entered its current `state` (drives "has been waiting 20m"). */
  stateSince: string;
  previousState?: ThreadState;
}

/** A full poll result. Persisted to the store; surfaces read this. */
export interface StatusSnapshot {
  polledAt: string;           // ISO
  threads: ThreadStatus[];
}

/** What changed between two polls — the substrate for proactive nudges. */
export interface StatusDiff {
  appeared: ThreadStatus[];   // new since last poll
  transitioned: ThreadStatus[]; // same thread, state changed
  resolved: ThreadStatus[];   // present last poll, gone now
}

/** Quiet at least this long → `idle`, regardless of who spoke last. Lo-fi; tune later. */
export const IDLE_AFTER_SECONDS = 30 * 60;

/** Normalize a raw scan topic for display: strip slash-command/caveat markup, collapse space. */
export function cleanTopic(raw: string): string {
  return raw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() || "(untitled)";
}

/**
 * Derive a thread's state from a raw scan row — no model. Last word was the assistant's →
 * it answered and is waiting on you (`needs-you`); last word was yours → the agent owes a
 * reply (`working`); quiet too long → `idle`.
 */
export function deriveState(row: Pick<ScanRow, "lastRole" | "secondsSinceLastMessage">): ThreadState {
  if (row.secondsSinceLastMessage >= IDLE_AFTER_SECONDS) return "idle";
  return row.lastRole === "assistant" ? "needs-you" : "working";
}

/** Loudest-first ordering for the sidebar: needs-you → working → idle → done, then most recent. */
export const STATE_RANK: Record<ThreadState, number> = { "needs-you": 0, working: 1, idle: 2, done: 3 };
/** Generic so callers (e.g. SidebarThread) keep their richer type through the sort. */
export function sortByAttention<T extends ThreadStatus>(threads: readonly T[]): T[] {
  return [...threads].sort(
    (a, b) => STATE_RANK[a.state] - STATE_RANK[b.state] || b.lastMessageAt.localeCompare(a.lastMessageAt),
  );
}

/**
 * Join a fresh scan against the previous snapshot to produce the next one — the heart of
 * the state machine's continuity. Carries `firstSeen`, and resets `stateSince` /
 * `previousState` only on an actual state change. Pure: same inputs → same snapshot.
 */
export function reconcile(prev: StatusSnapshot | null, rows: readonly ScanRow[], nowIso: string): StatusSnapshot {
  const byId = new Map((prev?.threads ?? []).map((t) => [t.id, t]));
  const threads = rows.map((row): ThreadStatus => {
    const state = deriveState(row);
    const was = byId.get(row.id);
    const changed = !was || was.state !== state;
    return {
      id: row.id,
      source: row.source,
      repo: row.repo,
      app: row.app,
      topic: cleanTopic(row.topic),
      state,
      lastActive: formatRelative(row.secondsSinceLastMessage),
      createdAt: row.createdAt,
      lastMessageAt: row.lastMessageAt,
      firstSeen: was?.firstSeen ?? nowIso,
      stateSince: changed ? nowIso : was!.stateSince,
      previousState: changed ? was?.state : was!.previousState,
    };
  });
  return { polledAt: nowIso, threads };
}

/**
 * Threads that just ENTERED `needs-you` (a new assistant response landed → now waiting on the
 * operator). These are the only threads worth a targeted LLM nextStep refresh — everything else
 * the cheap poll handles with status/recency alone. Event-driven, not every-poll.
 */
export function becameNeedsYou(diff: StatusDiff): ThreadStatus[] {
  return diff.transitioned.filter((t) => t.state === "needs-you");
}

/** Diff two snapshots by thread id. `null` prev → everything appeared. */
export function diffSnapshots(prev: StatusSnapshot | null, next: StatusSnapshot): StatusDiff {
  const prevById = new Map((prev?.threads ?? []).map((t) => [t.id, t]));
  const nextById = new Map(next.threads.map((t) => [t.id, t]));
  return {
    appeared: next.threads.filter((t) => !prevById.has(t.id)),
    transitioned: next.threads.filter((t) => prevById.get(t.id)?.state && prevById.get(t.id)!.state !== t.state),
    resolved: (prev?.threads ?? []).filter((t) => !nextById.has(t.id)),
  };
}

/** Lo-fi relative-time formatter (the scan's JSON gives seconds, not a string). */
export function formatRelative(seconds: number): string {
  if (seconds < 45) return "just now";
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.round(seconds / 3600);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.round(seconds / 86400);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}
