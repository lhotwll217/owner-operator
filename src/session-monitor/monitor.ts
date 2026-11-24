import { watch as fsWatch, type FSWatcher } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  loadActiveWindow,
  loadMonitoredTranscriptStores,
  isOnboarded,
  openCodeDatabasePath,
  type ScanRow,
  type SessionStateRow,
  type ThreadEnrichment,
  type EnrichmentCandidate,
} from "@owner-operator/core";
import type { State } from "../state/state";
import { ClaudeDesktopSessions } from "./claude-desktop-sessions";
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
  /** Claude desktop session records, the source of Claude rows' deep links. */
  claudeDesktop?: Pick<ClaudeDesktopSessions, "links">;
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

const NO_CUTOFF = "1970-01-01";

async function scanTranscripts(since: string, limit: number, files: readonly string[] = []): Promise<ScanRow[]> {
  if (!isOnboarded()) return [];
  const parsed = await runTranscriptScan([
    "--since", since, "--limit", String(limit), "--sample", "0", "--all",
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
    turnEnd: thread.turnEnd ?? null,
    link: typeof thread.link === "string" ? thread.link : null,
    ...(typeof thread.diffAdded === "number" ? { diffAdded: thread.diffAdded } : {}),
    ...(typeof thread.diffDeleted === "number" ? { diffDeleted: thread.diffDeleted } : {}),
    automated: Boolean(thread.automated),
  }));
}

/** Session ingestion and asynchronous reconciliation through State. */
export class SessionMonitor {
  private timer: NodeJS.Timeout | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private watchers: FSWatcher[] = [];
  private transcriptWatchers = new Map<string, FSWatcher>();
  private watching = false;
  private watchRoots: readonly string[] | undefined;
  private polling = false;
  private pendingFiles = new Set<string>();
  private enriching = false;
  private enrichAgain = false;
  private readonly logger: (record: SessionMonitorLogRecord) => void;
  private readonly claudeDesktop: Pick<ClaudeDesktopSessions, "links"> | null;
  current: SessionStateRow[] = [];

  constructor(private readonly state: State, private readonly options: SessionMonitorOptions = {}) {
    this.logger = options.logger ?? (() => undefined);
    // The desktop index reads the owner's real records, so by default it rides with the real
    // transcript scan; an injected scan is a fixture and gets no links unless they are injected too.
    this.claudeDesktop = options.claudeDesktop ?? (options.scan ? null : new ClaudeDesktopSessions());
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
      const scan = this.options.scan ?? scanTranscripts;
      const rows = await scan(this.options.since ?? loadActiveWindow(), this.options.limit ?? 0, files);
      if (!files.length) {
        const missedByWindow = this.state.visibleTranscriptPathsExcept(new Set(rows.flatMap((row) => row.transcriptPath ?? [])));
        if (missedByWindow.length) rows.push(...await scan(NO_CUTOFF, 0, missedByWindow));
      }
      const claudeIds = rows.filter((row) => row.source === "claude").map((row) => row.id);
      const desktop = this.claudeDesktop && claudeIds.length ? await this.claudeDesktop.links(claudeIds) : new Map<string, string>();
      this.state.recordPoll(desktop.size ? rows.map((row) => {
        const link = desktop.get(row.id);
        return link ? { ...row, link } : row;
      }) : rows);
      this.current = this.state.listCurrentSessionState();
      this.watchTranscripts();
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
    const stores = this.watchRoots ? [] : isOnboarded() ? loadMonitoredTranscriptStores() : [];
    const watchedRoots = this.watchRoots ?? stores.map((store) => store.root);
    for (const root of new Set(watchedRoots)) {
      this.arm(root, { recursive: true }, (file) => {
        if (/\.(?:jsonl|ndjson|json)$/.test(file)) this.scheduleReconcile(join(root, file));
      });
    }
    // OpenCode writes each turn to its database or WAL; the scan then re-reads its sessions. The
    // `-shm` index changes on every read, the scan's own included, so it never triggers one.
    const databases = stores.filter((store) => store.format === "opencode").map((store) => openCodeDatabasePath(store.root));
    for (const database of new Set(databases)) {
      const written = new Set([basename(database), `${basename(database)}-wal`]);
      this.arm(dirname(database), {}, (file) => {
        if (written.has(file)) this.scheduleReconcile(database);
      });
    }
  }

  private arm(path: string, options: { recursive?: boolean }, onFile: (file: string) => void): void {
    try {
      const watcher = fsWatch(path, options, (_event, file) => {
        if (typeof file === "string") onFile(file);
      });
      watcher.on("error", () => undefined);
      watcher.unref?.();
      this.watchers.push(watcher);
    } catch {
      // The interval is the fallback for missing roots or unsupported recursive watch.
    }
  }

  /** The store watch (FSEvents on macOS) reports a write through a held-open descriptor only when
   * the file closes, and Codex App holds each rollout open for the life of the app session. A watch
   * on the file itself (kqueue) reports every write, so each visible session's transcript gets one. */
  private watchTranscripts(): void {
    if (!this.watching) return;
    const paths = new Set(this.state.visibleTranscriptPaths());
    for (const [path, watcher] of this.transcriptWatchers) {
      if (!paths.has(path)) this.unwatchTranscript(path, watcher);
    }
    for (const path of paths) {
      if (this.transcriptWatchers.has(path)) continue;
      try {
        const watcher = fsWatch(path, (event) => {
          // A replaced or removed file keeps no watch; the poll this schedules re-arms a live one.
          if (event === "rename") this.unwatchTranscript(path, watcher);
          this.scheduleReconcile(path);
        });
        watcher.on("error", () => {
          this.unwatchTranscript(path, watcher);
          this.scheduleReconcile(path);
        });
        watcher.unref?.();
        this.transcriptWatchers.set(path, watcher);
        // A write between this poll's read and the watch going live was reported to no one.
        this.pendingFiles.add(path);
      } catch {
        // Not a file on disk (an OpenCode `<db>#<id>` session, or one already removed).
      }
    }
  }

  private unwatchTranscript(path: string, watcher: FSWatcher): void {
    watcher.close();
    if (this.transcriptWatchers.get(path) === watcher) this.transcriptWatchers.delete(path);
  }

  /** The first change starts the flush and later ones join it, so a transcript written more often
   * than the debounce cannot hold back every other session's change. */
  scheduleReconcile(file?: string): void {
    if (file) this.pendingFiles.add(file);
    if (this.debounce) return;
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
    for (const watcher of this.transcriptWatchers.values()) watcher.close();
    this.transcriptWatchers.clear();
  }

  private scheduleEnrichment(): void {
    if (this.options.canEnrich?.() === false || !this.options.enrich) return;
    if (this.enriching) { this.enrichAgain = true; return; }
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
      // tight loop, and one failing thread cannot block the rest. A poll that lands
      // mid-pass gets its own pass afterwards instead of waiting for the next tick.
      do {
        this.enrichAgain = false;
        const queue = this.state.listEnrichmentCandidates().filter((candidate) => candidate.lastMessageAt);
        const workers = Math.min(this.options.enrichConcurrency ?? 10, queue.length);
        await Promise.all(Array.from({ length: workers }, async () => {
          for (let candidate = queue.shift(); candidate; candidate = queue.shift()) await this.enrichOne(candidate);
        }));
      } while (this.enrichAgain);
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
