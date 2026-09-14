import { isActiveState, sortByAttention, STATE_RANK, type ThreadStatus } from "./status";

/** The model-authored detail fields we cache and join onto a thread by id (the enrichment). */
export interface ThreadDetails {
  topic?: string;
  summary?: string;
  priority?: number;
}

export interface ThreadEnrichment extends Required<ThreadDetails> {
  attention: "idle" | "needs-you";
}

/** One live thread plus its optional cached model details. */
export interface SessionStateThread extends ThreadStatus {
  generatedTopic?: string;
  summary?: string;
  priority?: number;
  /** False once status is `done`; done rows leave the active view. */
  active: boolean;
  /** Row number (1…n in display order) — stable for row-number tools. */
  num?: number;
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
      summary: d?.summary,
      priority: d?.priority,
      active,
    };
  });
}

export interface NumberedSessionState { groups: SessionStateGroup[]; byNum: Map<number, SessionStateThread>; }

/**
 * Group + number session-state rows: ACTIVE threads only (done rows drop off), numbered 1…n in display
 * order. Pure: numbers go on copies.
 */
export function numberSessionStateRows(threads: readonly SessionStateThread[]): NumberedSessionState {
  const groups = groupSessionStateByRepo(threads.filter((t) => t.active))
    .map((g): SessionStateGroup => ({ ...g, threads: g.threads.map((t) => ({ ...t })) }));
  const byNum = new Map<number, SessionStateThread>();
  let n = 0;
  for (const g of groups) for (const t of g.threads) { t.num = ++n; byNum.set(n, t); }
  return { groups, byNum };
}

export interface SessionStateGroup { repo: string; threads: SessionStateThread[]; }

/** Group by repo; within a group loudest-first; groups ordered by their loudest thread. */
export function groupSessionStateByRepo(threads: readonly SessionStateThread[]): SessionStateGroup[] {
  const byRepo = new Map<string, SessionStateThread[]>();
  for (const t of threads) (byRepo.get(t.repo) ?? byRepo.set(t.repo, []).get(t.repo)!).push(t);
  const groups = [...byRepo.entries()].map(([repo, ts]) => ({ repo, threads: sortByAttention(ts) }));
  return groups.sort((a, b) => {
    const ra = STATE_RANK[a.threads[0].state], rb = STATE_RANK[b.threads[0].state];
    return ra - rb || b.threads[0].lastMessageAt.localeCompare(a.threads[0].lastMessageAt) || a.repo.localeCompare(b.repo);
  });
}
