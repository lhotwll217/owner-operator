import { watch as fsWatch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import {
  loadActiveWindow,
  loadMonitoredTranscriptStores,
  isOnboarded,
  type ScanRow,
  type SessionStateRow,
  type ThreadEnrichment,
  type EnrichmentCandidate,
} from "@owner-operator/core";
import type { State } from "../state/state";
import { runTranscriptScan } from "./scan";

export interface SessionMonitorOptions {
  since?: string;
  limit?: number;
  intervalMs?: number;
  debounceMs?: number;
  scan?: (since: string, limit: number, files?: readonly string[]) => Promise<ScanRow[]>;
  /** Enrichment calls in flight at once. */
  enrichConcurrency?: number;
  enrich?: (candidate: EnrichmentCandidate) => Promise<ThreadEnrichment>;
  canEnrich?: () => boolean;
  logger?: (record: SessionMonitorLogRecord) => void;
}

export enum SessionMonitorLogEvent {
  PollFailed = "poll-failed",
  EnrichmentFailed = "enrichment-failed",
  EnrichmentDiscarded = "enrichment-discarded",
}

export interface SessionMonitorLogRecord {
  event: SessionMonitorLogEvent;
  error: string;
}

async function scanTranscripts(since: string, limit: number, files: readonly string[] = []): Promise<ScanRow[]> {
  if (!isOnboarded()) return [];
  const parsed = await runTranscriptScan([
    "--since", since, "--limit", String(limit), "--sample", "0",
  ], files);
  return parsed.threads.map((thread): ScanRow => ({
    id: String(thread.id),
    source: String(thread.source ?? ""),
    repo: String(thread.repo ?? ""),
    ...(typeof thread.project === "string" ? { project: thread.project } : {}),
    ...(typeof thread.file === "string" ? { transcriptPath: thread.file } : {}),
    app: String(thread.ui ?? ""),
    topic: String(thread.topic ?? ""),
    lastRole: String(thread.lastRole ?? ""),
    createdAt: String(thread.createdAt ?? ""),
    lastMessageAt: String(thread.lastMessageAt ?? ""),
    secondsSinceLastMessage: Number(thread.secondsSinceLastMessage ?? 0),
    secondsSinceActivity: Number(thread.secondsSinceActivity ?? thread.secondsSinceLastMessage ?? 0),
    working: Boolean(thread.working),
    link: typeof thread.link === "string" ? thread.link : null,
    ...(typeof thread.diffAdded === "number" ? { diffAdded: thread.diffAdded } : {}),
    ...(typeof thread.diffDeleted === "number" ? { diffDeleted: thread.diffDeleted } : {}),
  }));
}

/** Session ingestion and asynchronous reconciliation through State. */
export class SessionMonitor {
  private timer: NodeJS.Timeout | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private watchers: FSWatcher[] = [];
  private watching = false;
  private watchRoots: readonly string[] | undefined;
  private polling = false;
  private pendingFiles = new Set<string>();
  private enriching = false;
  private readonly logger: (record: SessionMonitorLogRecord) => void;
  current: SessionStateRow[] = [];

  constructor(private readonly state: State, private readonly options: SessionMonitorOptions = {}) {
    this.logger = options.logger ?? (() => undefined);
  }

  /** A full scan of every monitored store, or with `files` only the transcripts that changed. */
  async poll(files: readonly string[] = []): Promise<SessionStateRow[]> {
    if (this.polling) {
      for (const file of files) this.pendingFiles.add(file);
      return this.current;
    }
    this.polling = true;
    try {
      this.armWatchers();
      const rows = await (this.options.scan ?? scanTranscripts)(
        this.options.since ?? loadActiveWindow(),
        this.options.limit ?? 0,
        files,
      );
      this.state.recordPoll(rows);
      this.current = this.state.listCurrentSessionState();
      this.scheduleEnrichment();
      return this.current;
    } finally {
      this.polling = false;
      if (this.pendingFiles.size) this.scheduleReconcile();
    }
  }

  /** A full scan now, then a tick that either rescans everything (no watcher armed) or only
   * reassesses working sessions on their cadence (the watcher already delivers every change). */
  start(): void {
    if (this.timer) return;
    this.pollInBackground();
    this.timer = setInterval(() => {
      if (this.watchers.length) this.scheduleEnrichment();
      else this.pollInBackground();
    }, this.options.intervalMs ?? 15_000);
    this.timer.unref?.();
  }

  watch(roots?: readonly string[]): void {
    this.watching = true;
    this.watchRoots = roots ? [...roots] : undefined;
    this.armWatchers();
  }

  private armWatchers(): void {
    if (!this.watching || this.watchers.length > 0) return;
    const watchedRoots = this.watchRoots ?? (
      isOnboarded() ? loadMonitoredTranscriptStores().map((store) => store.root) : []
    );
    for (const root of new Set(watchedRoots)) {
      try {
        const watcher = fsWatch(root, { recursive: true }, (_event, file) => {
          if (typeof file === "string" && /\.(?:jsonl|ndjson|json)$/.test(file)) this.scheduleReconcile(join(root, file));
        });
        watcher.on("error", () => undefined);
        watcher.unref?.();
        this.watchers.push(watcher);
      } catch {
        // The interval is the fallback for missing roots or unsupported recursive watch.
      }
    }
  }

  scheduleReconcile(file?: string): void {
    if (file) this.pendingFiles.add(file);
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      const files = [...this.pendingFiles];
      this.pendingFiles.clear();
      this.pollInBackground(files);
    }, this.options.debounceMs ?? 600);
    this.debounce.unref?.();
  }

  private pollInBackground(files: readonly string[] = []): void {
    this.runInBackground(SessionMonitorLogEvent.PollFailed, () => this.poll(files));
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.debounce) clearTimeout(this.debounce);
    this.timer = null;
    this.debounce = null;
    this.pendingFiles.clear();
    this.watching = false;
    this.watchRoots = undefined;
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
  }

  private scheduleEnrichment(): void {
    if (this.options.canEnrich?.() === false || !this.options.enrich || this.enriching) return;
    this.enriching = true;
    queueMicrotask(() => this.runEnrichmentInBackground());
  }

  private runEnrichmentInBackground(): void {
    this.runInBackground(SessionMonitorLogEvent.EnrichmentFailed, () => this.drainEnrichment());
  }

  private runInBackground(event: SessionMonitorLogEvent, work: () => Promise<unknown>): void {
    void work().catch((error) => {
      this.logger({
        event,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private async drainEnrichment(): Promise<void> {
    try {
      // One snapshot, one attempt per thread per pass: a candidate whose result is
      // rejected or whose call fails waits for the next poll instead of retrying in a
      // tight loop, and one failing thread cannot block the rest.
      const queue = this.state.listEnrichmentCandidates().filter((candidate) => candidate.lastMessageAt);
      const workers = Math.min(this.options.enrichConcurrency ?? 10, queue.length);
      await Promise.all(Array.from({ length: workers }, async () => {
        for (let candidate = queue.shift(); candidate; candidate = queue.shift()) await this.enrichOne(candidate);
      }));
    } finally {
      this.enriching = false;
    }
  }

  private async enrichOne(candidate: EnrichmentCandidate): Promise<void> {
    if (!this.options.enrich) return;
    try {
      const details = await this.options.enrich(candidate);
      if (!this.state.appendEnrichment(candidate.id, details, candidate.lastMessageAt!, candidate.children)) {
        this.logger({
          event: SessionMonitorLogEvent.EnrichmentDiscarded,
          error: `stale sample discarded for ${candidate.id}`,
        });
      }
    } catch (error) {
      this.logger({
        event: SessionMonitorLogEvent.EnrichmentFailed,
        error: `${candidate.id}: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
}

export { scanTranscripts };
