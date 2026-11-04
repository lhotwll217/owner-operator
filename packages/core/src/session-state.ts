import { isActiveState, type ThreadState, type ThreadStatus } from "./status";

/** The model-authored detail fields we cache and join onto a thread by id (the enrichment). */
export interface ThreadDetails {
  topic?: string;
  statusSummary?: string;
}

/** One assessment of a session. Each part is decided by its own call, so each may be absent:
 * `attention` while the session is working, the title and status summary when their call failed. */
export interface ThreadEnrichment extends ThreadDetails {
  attention?: "idle" | "needs-you";
  /**
   * Where the evidence for this assessment ended: the message index a tool-inclusive read
   * reached, and that message's time. The composition that samples the transcript fills it in;
   * the model does not choose it. A revision keeps it so a later reader can return to the point
   * the account was written from.
   */
  bookmark?: { index: number; messageAt: string };
}

/** One live thread plus its optional cached model details. */
export interface SessionStateThread extends ThreadStatus {
  generatedTopic?: string;
  statusSummary?: string;
  /** False once status is `done`; done rows leave the active view. */
  active: boolean;
}

/** Title to show — an owner rename always wins, then the generated title, else the raw digest topic. */
export function displayTitle(t: SessionStateThread): string {
  return t.ownerTitle || t.generatedTopic || t.topic;
}

/**
 * Session state = current threads, each enriched by the cached model
 * details joined by id. New threads appear as the poll sees them.
 */
export function toSessionStateThreads(
  threads: readonly ThreadStatus[],
  details: ReadonlyMap<string, ThreadDetails>,
): SessionStateThread[] {
  return threads.map((t): SessionStateThread => {
    const d = details.get(t.id);
    const active = isActiveState(t.state);
    return {
      ...t,
      generatedTopic: d?.topic,
      statusSummary: d?.statusSummary,
      active,
    };
  });
}

/** The panel's sections, in display order. Every visible row is in exactly one. */
export const SESSION_SECTIONS = ["needs-you", "working", "idle", "snoozed"] as const;
export type SessionSection = (typeof SESSION_SECTIONS)[number];

/** An owner snooze, reported only while it holds: until an instant, or until the next message. */
export type Snooze = { kind: "until"; until: string } | { kind: "next-message" };

/** What arrangement reads from a projected row. Done rows never reach it. */
export interface SessionFacts {
  id: string;
  state: Exclude<ThreadState, "done">;
  snooze: Snooze | null;
  parentThreadId: string | null;
  createdAt: string | null;
  lastMessageAt: string | null;
}

const newestFirst = (a: string | null, b: string | null): number =>
  a === b ? 0 : a === null ? 1 : b === null ? -1 : a > b ? -1 : 1;

const byKey = (key: "createdAt" | "lastMessageAt") => (a: SessionFacts, b: SessionFacts): number =>
  newestFirst(a[key], b[key]) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const sectionKey = (section: SessionSection) => byKey(section === "working" ? "createdAt" : "lastMessageAt");

/**
 * The one display order every surface shares. A root's section is `snoozed` while its snooze
 * holds, else its state. Sections run needs-you, working, idle, snoozed. Settled rows order by
 * their latest message and working rows by creation, newest first, so a working row never
 * shuffles. A delegated child follows its parent one level deeper, in the parent's section; a
 * child whose parent is not in the input is a root.
 */
export function arrangeSessionState<R extends SessionFacts>(
  rows: readonly R[],
): Array<R & { section: SessionSection; depth: number }> {
  const ids = new Set(rows.map((row) => row.id));
  const children = new Map<string, R[]>();
  const roots = new Map<SessionSection, R[]>(SESSION_SECTIONS.map((section) => [section, []]));
  for (const row of rows) {
    if (row.parentThreadId !== null && ids.has(row.parentThreadId)) {
      (children.get(row.parentThreadId) ?? children.set(row.parentThreadId, []).get(row.parentThreadId)!).push(row);
    } else {
      roots.get(row.snooze ? "snoozed" : row.state)!.push(row);
    }
  }
  const arranged: Array<R & { section: SessionSection; depth: number }> = [];
  const emit = (row: R, section: SessionSection, depth: number): void => {
    arranged.push({ ...row, section, depth });
    for (const child of (children.get(row.id) ?? []).sort(byKey("createdAt"))) emit(child, section, depth + 1);
  };
  for (const section of SESSION_SECTIONS) {
    for (const root of roots.get(section)!.sort(sectionKey(section))) emit(root, section, 0);
  }
  return arranged;
}
