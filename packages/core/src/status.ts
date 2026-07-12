// Owner Operator — thread status & state machine.
//
// UI-INDEPENDENT and MODEL-FREE: everything here is derived from the cheap deterministic
// scan (lastRole + freshness), never the LLM. That's the split that lets session state poll
// fast and for free — expensive model enrichment refreshes slowly and separately. Pure
// functions only, same contract every surface renders.

// The canonical resolver — raw scan candidates joined with persisted owner state. Every
// surface (monitor, session-state tools, the scanner itself) resolves through these, never its
// own rule. Plain ESM in resolve.mjs so the zero-install scan skill runs the same code.
export {
  IDLE_AFTER_SECONDS,
  deriveState,
  holdsDone,
  resolveState,
  isActiveState,
  resolveCandidates,
} from "./resolve.mjs";

/**
 * Lifecycle state of a thread — lo-fi and distinct from `priority` (priority = how loud;
 * state = what's happening). Mirrors the bounded vocabulary agent-deck polls for.
 * `done` is OPERATOR-set (`/done` / mark_thread_done) — transcripts can't observe
 * "resolved" — and holds until a newer message wakes the thread (see resolve.mjs).
 */
export type ThreadState = "needs-you" | "working" | "idle" | "done";

/** The subset of a raw scan row (`scan-active-transcripts --json`) the state machine needs. */
export interface ScanRow {
  id: string;
  source: string;
  repo: string;
  /** Session cwd (absolute) — the identity the privacy blacklist matches on. */
  project?: string;
  /** Absolute path of the source transcript, when the adapter has one. */
  transcriptPath?: string;
  /** App / GUI the session was made from (the scan's `ui`). */
  app: string;
  topic: string;
  /** Role of the last message — "user" | "assistant" | … */
  lastRole: string;
  createdAt: string;          // ISO
  lastMessageAt: string;      // ISO
  secondsSinceLastMessage: number;
  /** Seconds since the LAST event of any kind (file write). Informational only — GUI apps
   *  append housekeeping events that keep this forever fresh, so state/recency use
   *  `secondsSinceLastMessage` + the `working` flag instead. */
  secondsSinceActivity: number;
  /** A turn is in progress (Codex task running / Claude tool-loop) — the agent hasn't yielded. */
  working: boolean;
  link?: string | null;
  /** Workspace line delta vs the repo's base branch (scan-gathered), when there is one. */
  diffAdded?: number;
  diffDeleted?: number;
}

/** One polled thread with continuity across polls — the unit session-state projections use. */
export interface ThreadStatus {
  id: string;
  source: string;
  repo: string;
  /** Session cwd (absolute) — kept so the blacklist can purge stored rows by path. */
  project?: string;
  app: string;
  topic: string;
  /** Owner-set title (widget rename). Preferred over every generated topic at display;
   *  the model keeps generating topics underneath (the audit trail). Absent = generated titles show. */
  ownerTitle?: string;
  state: ThreadState;
  /** Relative freshness for display, e.g. "7 minutes ago". */
  lastActive: string;
  createdAt: string;          // ISO
  lastMessageAt: string;      // ISO
  /** ISO of the first poll that saw this thread. */
  firstSeen: string;
  /** Workspace line delta vs the repo's base branch — used for +N −N badges. */
  diffAdded?: number;
  diffDeleted?: number;
}

/** Normalize a raw scan topic for display: strip slash-command/caveat markup, collapse space. */
export function cleanTopic(raw: string): string {
  return raw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() || "(untitled)";
}

/** Loudest-first ordering: needs-you → working → idle → done, then most recent. */
export const STATE_RANK: Record<ThreadState, number> = { "needs-you": 0, working: 1, idle: 2, done: 3 };
/** Generic so callers keep their richer type through the sort. */
export function sortByAttention<T extends ThreadStatus>(threads: readonly T[]): T[] {
  return [...threads].sort(
    (a, b) => STATE_RANK[a.state] - STATE_RANK[b.state] || b.lastMessageAt.localeCompare(a.lastMessageAt),
  );
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
