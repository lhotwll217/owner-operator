// Owner Operator — durable status store. The "results backend" for the poll: the scan +
// state machine run once, the result lands here, and every surface reads it instead of
// re-scanning. SQLite (threads-db.ts) is the source of truth behind this seam; the JSON
// files are a DERIVED, read-only export (and a one-time legacy seed).
//
// MULTI-CONSUMER WRITING — the contract for any new consumer (widget, web, scripts):
//   • Read anywhere: loadSnapshot()/loadTriage() here; status.json for zero-dependency
//     readers (the scan skill's resolver join); or the db read-only.
//   • WRITE ONLY THROUGH THIS SEAM (or ThreadDb directly). Never write status.json — it
//     is regenerated after every commit here, so a direct write is silently lost.
//   • Concurrency is safe by mechanism, not discipline: every op is one IMMEDIATE
//     transaction, and saveSnapshot re-applies the canonical done-hold at the write
//     boundary (threads-db.ts), so a writer holding a stale snapshot can't resurrect a
//     done thread. New writers inherit both for free by going through the seam.
//   • The daemon (daemon.ts) IS that single writer when it runs — surfaces resolve it via
//     client.ts and this seam becomes its internal API; the status.json export stays for
//     cold readers either way.

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import type { StatusSnapshot, ThreadStatus, TriageInfo } from "@owner-operator/core";
import { ThreadDb } from "./threads-db";

export const STORE_DIR = process.env.OO_HOME ?? join(homedir(), ".owner-operator");
/** The derived snapshot export — read-only for consumers; regenerated after every write. */
export const STATUS_FILE = join(STORE_DIR, "status.json");
/** Legacy triage cache — seed input only; no longer written (triage lives in the db). */
export const TRIAGE_FILE = join(STORE_DIR, "triage.json");
/** Daemon discovery file ({ port, pid, startedAt }) — written by the daemon, read by clients. */
export const DAEMON_FILE = join(STORE_DIR, "daemon.json");

let db: ThreadDb | null = null;
function getDb(): ThreadDb {
  if (!db) {
    db = new ThreadDb();
    seedLegacyJson(db);
  }
  return db;
}

// One-time migration: a box that ran the JSON-only store has state worth keeping (operator
// dones, triage titles). Seed the empty db from the legacy files; from then on the db is
// truth and status.json is output-only.
function seedLegacyJson(target: ThreadDb): void {
  if (!target.isEmpty()) return;
  try {
    const snap = JSON.parse(readFileSync(STATUS_FILE, "utf8")) as StatusSnapshot;
    if (Array.isArray(snap?.threads)) target.saveSnapshot(snap);
  } catch { /* no legacy snapshot */ }
  try {
    const obj = JSON.parse(readFileSync(TRIAGE_FILE, "utf8")) as Record<string, TriageInfo>;
    for (const [id, info] of Object.entries(obj)) target.upsertTriage(id, info, "model");
  } catch { /* no legacy triage */ }
}

/** The daemon's privileged handle (schedules, direct queries). Surfaces stay on the seam. */
export function storeDb(): ThreadDb {
  return getDb();
}

// Atomic write (temp + rename) so a status.json reader never sees a partial file.
function writeAtomic(file: string, data: unknown): void {
  mkdirSync(STORE_DIR, { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, file);
}

/** Last persisted poll snapshot, or null if none yet / store unreadable. */
export function loadSnapshot(): StatusSnapshot | null {
  try {
    return getDb().loadSnapshot();
  } catch {
    return null;
  }
}

/**
 * Persist the poll snapshot (frequent writes, every poll). Returns the STORED truth and
 * refreshes the status.json export — under concurrent writers the write-boundary
 * done-hold may adjust rows, so callers must render what comes back, not what they sent.
 */
export function saveSnapshot(snapshot: StatusSnapshot): StatusSnapshot {
  const d = getDb();
  d.saveSnapshot(snapshot);
  const stored = d.loadSnapshot() ?? snapshot;
  writeAtomic(STATUS_FILE, stored);
  return stored;
}

/** Cached triage enrichment keyed by thread id — joined onto the live poll set at render. */
export function loadTriage(): Map<string, TriageInfo> {
  try {
    return getDb().getTriageMap();
  } catch {
    return new Map();
  }
}

/**
 * Persist the triage cache (written on each full/targeted triage). Append-only versions
 * under the hood; unchanged entries are skipped, so re-saving the whole map stays cheap.
 */
export function saveTriage(triage: ReadonlyMap<string, TriageInfo>): void {
  const d = getDb();
  for (const [id, info] of triage) d.upsertTriage(id, info, "model");
}

export interface MarkThreadsDoneResult {
  snapshot: StatusSnapshot | null;
  marked: ThreadStatus[];
  missingIds: string[];
}

/**
 * Mark threads done in the persisted snapshot — one transaction in the db (no
 * read-modify-write window for another consumer to clobber), then refresh the export.
 */
export function markThreadsDone(ids: readonly string[], opts: { now?: string } = {}): MarkThreadsDoneResult {
  const uniqueIds = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
  const snapshot = loadSnapshot();
  if (!snapshot) return { snapshot: null, marked: [], missingIds: uniqueIds };
  if (!uniqueIds.length) return { snapshot, marked: [], missingIds: [] };

  const result = getDb().markThreadsDone(uniqueIds, opts.now ?? new Date().toISOString());
  if (result.snapshot) writeAtomic(STATUS_FILE, result.snapshot);
  return result;
}
