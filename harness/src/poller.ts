// Owner Operator — status poller. The "pull" behind the sidebar: on an interval it runs the
// cheap deterministic scan (NO model), derives each thread's state, reconciles against the
// last snapshot for continuity, persists, and emits to subscribers. This is agent-deck's
// poll-the-transcripts pattern over our own scan skill — the model never enters the hot loop.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { watch as fsWatch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import {
  reconcile,
  diffSnapshots,
  type ScanRow,
  type StatusSnapshot,
  type StatusDiff,
} from "@owner-operator/core";
import { repoRoot } from "./agent";
import { loadSnapshot, saveSnapshot } from "./store";

const execFileP = promisify(execFile);
const SCAN = join(repoRoot, ".agents/skills/get-active-threads/get-active-threads.mjs");

export type StatusListener = (snapshot: StatusSnapshot, diff: StatusDiff) => void;

export interface PollerOptions {
  /** Scan window (default "today"). */
  since?: string;
  /** Max threads (default 50). */
  limit?: number;
  /** Interval-poll cadence in ms — the FALLBACK/reconciliation path (default 15s). */
  intervalMs?: number;
  /** Debounce for watcher-triggered reconciles in ms (default 600). */
  debounceMs?: number;
  /** Test seam: deterministic replacement for the session-file scan. */
  scan?: (since: string, limit: number) => Promise<ScanRow[]>;
}

const SESSION_ROOTS = [join(homedir(), ".claude", "projects"), join(homedir(), ".codex", "sessions")];

// Run the scan with no message bodies (--sample 0) — we only need metadata for status, so
// keep the payload tiny and fast. --include-done because the state machine needs EVERY
// candidate: done-suppression happens in reconcile (via the canonical resolver); if the
// scan dropped done rows here, they'd leave the snapshot, orphan the persisted `done`,
// and resurface as active on the next pass.
async function runScan(since: string, limit: number): Promise<ScanRow[]> {
  const { stdout } = await execFileP(
    "node",
    [SCAN, "--since", since, "--limit", String(limit), "--sample", "0", "--json", "--include-done"],
    { maxBuffer: 32 * 1024 * 1024 },
  );
  const parsed = JSON.parse(stdout) as { threads?: Array<Record<string, any>> };
  return (parsed.threads ?? []).map((t): ScanRow => ({
    id: t.id,
    source: t.source,
    repo: t.repo,
    project: t.project,
    app: t.ui, // scan calls it `ui`; our model calls it `app`
    topic: t.topic,
    lastRole: t.lastRole,
    createdAt: t.createdAt,
    lastMessageAt: t.lastMessageAt,
    secondsSinceLastMessage: t.secondsSinceLastMessage,
    secondsSinceActivity: t.secondsSinceActivity ?? t.secondsSinceLastMessage,
    working: !!t.working,
    link: t.link ?? null,
    diffAdded: t.diffAdded,
    diffDeleted: t.diffDeleted,
  }));
}

/** Polls the scan into persisted, state-tagged snapshots. start/stop + subscribe. */
export class StatusPoller {
  private timer: NodeJS.Timeout | null = null;
  private watchers: FSWatcher[] = [];
  private debounce: NodeJS.Timeout | null = null;
  private listeners = new Set<StatusListener>();
  private polling = false;
  current: StatusSnapshot | null = loadSnapshot();

  constructor(private readonly opts: PollerOptions = {}) {}

  /** Subscribe to fresh snapshots. Fires immediately with the last snapshot if we have one. */
  subscribe(fn: StatusListener): () => void {
    this.listeners.add(fn);
    if (this.current) fn(this.current, { appeared: this.current.threads, transitioned: [], resolved: [] });
    return () => this.listeners.delete(fn);
  }

  /** Poll once now. Returns the fresh snapshot, or the last good one on a transient failure. */
  async poll(): Promise<StatusSnapshot | null> {
    if (this.polling) return this.current; // never overlap a slow scan
    this.polling = true;
    try {
      const rows = await (this.opts.scan ?? runScan)(this.opts.since ?? "today", this.opts.limit ?? 50);
      // The store is the source of truth because operator actions can land outside this
      // poller's in-memory `current` snapshot — other processes included.
      const prev = loadSnapshot() ?? this.current;
      const next = reconcile(prev, rows, new Date().toISOString());
      // The store re-applies the done-hold at the write boundary and returns the STORED
      // truth — under a concurrent writer it can differ from `next`; render what it kept.
      const stored = saveSnapshot(next);
      const diff = diffSnapshots(prev, stored);
      this.current = stored;
      for (const fn of this.listeners) fn(stored, diff);
      return stored;
    } catch {
      return this.current; // keep the last good snapshot rather than blanking the sidebar
    } finally {
      this.polling = false;
    }
  }

  /** Begin polling on the interval (polls once immediately). Idempotent. The interval is the
   *  FALLBACK — call watch() for the responsive path. */
  start(): void {
    if (this.timer) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.opts.intervalMs ?? 15_000);
    this.timer.unref?.(); // don't keep the process alive just for the poll
  }

  /**
   * The RESPONSIVE path: watch the session dirs and reconcile (debounced) on a transcript write,
   * so a new session or an agent's response shows in ~1s instead of waiting for the interval.
   * Recursive fs.watch is supported on macOS/Windows; on Linux the interval poll covers it.
   */
  watch(roots: string[] = SESSION_ROOTS): void {
    for (const root of roots) {
      try {
        const w = fsWatch(root, { recursive: true }, (_event, file) => {
          if (typeof file === "string" && file.endsWith(".jsonl")) this.scheduleReconcile();
        });
        w.on("error", () => { /* transient watch error → interval poll covers it */ });
        w.unref?.();
        this.watchers.push(w);
      } catch { /* dir missing / recursive unsupported → interval poll is the fallback */ }
    }
  }

  // Coalesce a burst of writes (an agent appending a turn = many events) into one reconcile.
  private scheduleReconcile(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => { this.debounce = null; void this.poll(); }, this.opts.debounceMs ?? 600);
    this.debounce.unref?.();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.debounce) { clearTimeout(this.debounce); this.debounce = null; }
    for (const w of this.watchers) { try { w.close(); } catch { /* ignore */ } }
    this.watchers = [];
  }
}
