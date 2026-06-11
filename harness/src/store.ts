// Owner Operator — durable status store. The "results backend" for the poll: the scan +
// state machine run once, the snapshot lands here, and every surface reads it instead of
// re-scanning. Lo-fi JSON today; the read/write seam is the contract, so swapping in sqlite
// later is a one-file change. Atomic write (temp + rename) so a reader never sees a partial.

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import type { StatusSnapshot, ThreadStatus, TriageInfo } from "@owner-operator/core";

export const STORE_DIR = process.env.OO_HOME ?? join(homedir(), ".owner-operator");
export const STATUS_FILE = join(STORE_DIR, "status.json");
export const TRIAGE_FILE = join(STORE_DIR, "triage.json");

function writeAtomic(file: string, data: unknown): void {
  mkdirSync(STORE_DIR, { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, file);
}

/** Last persisted poll snapshot (status + digest), or null if none yet / unreadable. */
export function loadSnapshot(): StatusSnapshot | null {
  try {
    return JSON.parse(readFileSync(STATUS_FILE, "utf8")) as StatusSnapshot;
  } catch {
    return null;
  }
}

/** Persist the poll snapshot atomically (frequent writes, every poll). */
export function saveSnapshot(snapshot: StatusSnapshot): void {
  writeAtomic(STATUS_FILE, snapshot);
}

/** Cached triage enrichment keyed by thread id — joined onto the live poll set at render. */
export function loadTriage(): Map<string, TriageInfo> {
  try {
    const obj = JSON.parse(readFileSync(TRIAGE_FILE, "utf8")) as Record<string, TriageInfo>;
    return new Map(Object.entries(obj));
  } catch {
    return new Map();
  }
}

/** Persist the triage cache atomically (written on each full/targeted triage). */
export function saveTriage(triage: ReadonlyMap<string, TriageInfo>): void {
  writeAtomic(TRIAGE_FILE, Object.fromEntries(triage));
}

export interface MarkThreadsDoneResult {
  snapshot: StatusSnapshot | null;
  marked: ThreadStatus[];
  missingIds: string[];
}

/** Mark threads done by updating the persisted status snapshot itself. */
export function markThreadsDone(ids: readonly string[], opts: { snapshot?: StatusSnapshot; now?: string } = {}): MarkThreadsDoneResult {
  const uniqueIds = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
  const snapshot = opts.snapshot ?? loadSnapshot();
  if (!snapshot) return { snapshot: null, marked: [], missingIds: uniqueIds };
  if (!uniqueIds.length) return { snapshot, marked: [], missingIds: [] };

  const wanted = new Set(uniqueIds);
  const marked: ThreadStatus[] = [];
  const now = opts.now ?? new Date().toISOString();
  const threads = snapshot.threads.map((t): ThreadStatus => {
    if (!wanted.has(t.id)) return t;
    const next: ThreadStatus = {
      ...t,
      state: "done",
      stateSince: t.state === "done" ? t.stateSince : now,
      previousState: t.state === "done" ? t.previousState : t.state,
    };
    marked.push(next);
    return next;
  });
  const markedIds = new Set(marked.map((t) => t.id));
  if (!marked.length) return { snapshot, marked: [], missingIds: uniqueIds };
  const next = { ...snapshot, threads };
  saveSnapshot(next);
  return {
    snapshot: next,
    marked,
    missingIds: uniqueIds.filter((id) => !markedIds.has(id)),
  };
}
