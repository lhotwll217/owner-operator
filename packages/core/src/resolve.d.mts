// Hand-written declarations for resolve.mjs (plain ESM so the scan skill can import it
// without a build step). Keep in lockstep with resolve.mjs — it's ~5 small functions.

import type { ThreadState, TurnEnd } from "./status";

/** Raw scan facts the resolver needs from a candidate row. */
export interface CandidateRow {
  id: string;
  lastRole: string;
  secondsSinceLastMessage: number;
  working: boolean;
  /** The latest turn's recorded end, or null when the record shows none. */
  turnEnd?: TurnEnd | null;
  lastMessageAt: string; // ISO
}

/** The slice of a persisted thread the resolver joins against. */
export interface PersistedThread {
  id: string;
  state: ThreadState;
  lastMessageAt: string; // ISO
}

export declare const IDLE_AFTER_SECONDS: number;

export declare function deriveState(
  row: Pick<CandidateRow, "lastRole" | "secondsSinceLastMessage" | "working" | "turnEnd">,
): ThreadState;

export declare function holdsDone(
  persisted: Pick<PersistedThread, "state" | "lastMessageAt"> | undefined,
  candidate: Pick<CandidateRow, "lastMessageAt">,
): boolean;

export declare function resolveState(
  persisted: Pick<PersistedThread, "state" | "lastMessageAt"> | undefined,
  candidate: Omit<CandidateRow, "id">,
): ThreadState;

export declare function isActiveState(state: ThreadState): boolean;

export declare function resolveCandidates<T extends CandidateRow>(
  candidates: readonly T[],
  persisted: readonly PersistedThread[] | null | undefined,
  opts?: { includeDone?: boolean },
): Array<T & { state: ThreadState }>;
