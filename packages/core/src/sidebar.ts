// Owner Operator — the sidebar data model.
//
// The sidebar is LIVE: its membership is the cheap poll's snapshot, minus threads whose status
// has been marked `done` — so new threads you start show up on the next tick. The model's triage is
// an ENRICHMENT overlay (title · priority · nextStep) joined by id; the chat cards are a
// separate, frozen render and the sidebar is NOT coupled to them. Untriaged/new threads still
// appear (raw digest topic + live status) until a triage enriches them. Pure + UI-independent.

import { isActiveState, sortByAttention, STATE_RANK, type StatusSnapshot, type ThreadState, type ThreadStatus } from "./status";

/** The subset of a model triage we cache and join onto a thread by id (the enrichment). */
export interface TriageInfo {
  topic?: string;      // a nicer title than the raw scan topic
  summary?: string;    // short card summary, when a model triage has produced one
  nextSteps?: string;  // the concrete next action (greyed on the sidebar)
  priority?: number;   // 5 (loudest) … 1
}

/** A sidebar row: the live polled thread + its (optional) cached triage enrichment. */
export interface SidebarThread extends ThreadStatus {
  triagedTopic?: string;
  summary?: string;
  nextSteps?: string;
  priority?: number;
  /** False once status is `done`; done rows leave the active sidebar. */
  active: boolean;
  /** Sidebar row number (1…n in display order) — the handle `/done 1,3` resolves. */
  num?: number;
}

/** Title to show — an owner rename always wins, then the triaged title, else the raw digest topic. */
export function displayTopic(t: SidebarThread): string {
  return t.ownerTitle || t.triagedTopic || t.topic;
}

/**
 * The sidebar = threads in the poll snapshot, each enriched by the cached
 * triage (title/priority/nextStep) joined by id. New threads appear as the poll sees them.
 */
export function toSidebarThreads(
  snapshot: StatusSnapshot,
  triage: ReadonlyMap<string, TriageInfo>,
): SidebarThread[] {
  return snapshot.threads.map((t): SidebarThread => {
    const tri = triage.get(t.id);
    const active = isActiveState(t.state);
    return {
      ...t,
      triagedTopic: tri?.topic,
      summary: tri?.summary,
      nextSteps: tri?.nextSteps,
      priority: tri?.priority,
      active,
    };
  });
}

export interface NumberedSidebar { groups: RepoGroup[]; byNum: Map<number, SidebarThread>; }

/**
 * Group + number the sidebar: ACTIVE threads only (done rows drop off), numbered 1…n in display
 * order — so the number you see is the number `/done` addresses. Pure: numbers go on copies.
 */
export function numberThreads(threads: readonly SidebarThread[]): NumberedSidebar {
  const groups = groupByRepo(threads.filter((t) => t.active))
    .map((g): RepoGroup => ({ ...g, threads: g.threads.map((t) => ({ ...t })) }));
  const byNum = new Map<number, SidebarThread>();
  let n = 0;
  for (const g of groups) for (const t of g.threads) { t.num = ++n; byNum.set(n, t); }
  return { groups, byNum };
}

/** Parse a `/done` argument — comma/space-separated row numbers → unique, in given order. */
export function parseNumbers(arg: string): number[] {
  const out: number[] = [];
  for (const m of arg.matchAll(/\d+/g)) { const n = Number(m[0]); if (!out.includes(n)) out.push(n); }
  return out;
}

export interface RepoGroup { repo: string; threads: SidebarThread[]; }

/** Group by repo; within a group loudest-first; groups ordered by their loudest thread. */
export function groupByRepo(threads: readonly SidebarThread[]): RepoGroup[] {
  const byRepo = new Map<string, SidebarThread[]>();
  for (const t of threads) (byRepo.get(t.repo) ?? byRepo.set(t.repo, []).get(t.repo)!).push(t);
  const groups = [...byRepo.entries()].map(([repo, ts]) => ({ repo, threads: sortByAttention(ts) }));
  return groups.sort((a, b) => {
    const ra = STATE_RANK[a.threads[0].state], rb = STATE_RANK[b.threads[0].state];
    return ra - rb || b.threads[0].lastMessageAt.localeCompare(a.threads[0].lastMessageAt) || a.repo.localeCompare(b.repo);
  });
}

/** Count threads by state — the stats line. */
export function stateCounts(threads: readonly SidebarThread[]): Record<ThreadState, number> {
  const c: Record<ThreadState, number> = { "needs-you": 0, working: 0, idle: 0, done: 0 };
  for (const t of threads) c[t.state]++;
  return c;
}
