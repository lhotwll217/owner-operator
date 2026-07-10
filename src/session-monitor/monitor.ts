import { watch as fsWatch, type FSWatcher } from "node:fs";
import {
  loadActiveWindow,
  loadSessionSources,
  type ScanRow,
  type SessionStateRow,
  type ThreadDetails,
  type EnrichmentCandidate,
} from "@owner-operator/core";
import type { State } from "../state/state";
import { runTranscriptScan } from "./scan";

export interface SessionMonitorOptions {
  since?: string;
  limit?: number;
  intervalMs?: number;
  debounceMs?: number;
  scan?: (since: string, limit: number) => Promise<ScanRow[]>;
  enrich?: (candidate: EnrichmentCandidate) => Promise<ThreadDetails>;
  logger?: (record: SessionMonitorLogRecord) => void;
}

export enum SessionMonitorLogEvent {
  PollFailed = "poll-failed",
  EnrichmentFailed = "enrichment-failed",
}

export interface SessionMonitorLogRecord {
  event: SessionMonitorLogEvent;
  error: string;
}

const SESSION_ROOTS = loadSessionSources().map((source) => source.root);

async function scanTranscripts(since: string, limit: number): Promise<ScanRow[]> {
  const parsed = await runTranscriptScan([
    "--since", since, "--limit", String(limit), "--sample", "0",
  ]);
  return parsed.threads.map((thread): ScanRow => ({
    id: String(thread.id),
    source: String(thread.source ?? ""),
    repo: String(thread.repo ?? ""),
    ...(typeof thread.project === "string" ? { project: thread.project } : {}),
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

/** Session ingestion plus its private, asynchronous needs-you enrichment worker. */
export class SessionMonitor {
  private timer: NodeJS.Timeout | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private watchers: FSWatcher[] = [];
  private polling = false;
  private enriching = false;
  private readonly logger: (record: SessionMonitorLogRecord) => void;
  current: SessionStateRow[] = [];

  constructor(private readonly state: State, private readonly options: SessionMonitorOptions = {}) {
    this.logger = options.logger ?? (() => undefined);
  }

  async poll(): Promise<SessionStateRow[]> {
    if (this.polling) return this.current;
    this.polling = true;
    try {
      const rows = await (this.options.scan ?? scanTranscripts)(
        this.options.since ?? loadActiveWindow(),
        this.options.limit ?? 50,
      );
      this.state.recordPoll(rows);
      this.current = this.state.listCurrentSessionState();
      this.scheduleEnrichment();
      return this.current;
    } finally {
      this.polling = false;
    }
  }

  start(): void {
    if (this.timer) return;
    this.pollInBackground();
    this.timer = setInterval(() => this.pollInBackground(), this.options.intervalMs ?? 15_000);
    this.timer.unref?.();
  }

  watch(roots: readonly string[] = SESSION_ROOTS): void {
    for (const root of roots) {
      try {
        const watcher = fsWatch(root, { recursive: true }, (_event, file) => {
          if (typeof file === "string" && /\.(?:jsonl|ndjson|json)$/.test(file)) this.scheduleReconcile();
        });
        watcher.on("error", () => undefined);
        watcher.unref?.();
        this.watchers.push(watcher);
      } catch {
        // The interval is the fallback for missing roots or unsupported recursive watch.
      }
    }
  }

  scheduleReconcile(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      this.pollInBackground();
    }, this.options.debounceMs ?? 600);
    this.debounce.unref?.();
  }

  private pollInBackground(): void {
    this.runInBackground(SessionMonitorLogEvent.PollFailed, () => this.poll());
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.debounce) clearTimeout(this.debounce);
    this.timer = null;
    this.debounce = null;
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
  }

  private scheduleEnrichment(): void {
    if (!this.options.enrich || this.enriching) return;
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
      for (;;) {
        const candidate = this.state.listEnrichmentCandidates()[0];
        if (!candidate?.lastMessageAt || !this.options.enrich) return;
        const details = await this.options.enrich(candidate);
        this.state.appendEnrichment(candidate.id, details, candidate.lastMessageAt);
      }
    } finally {
      this.enriching = false;
    }
  }
}

export { scanTranscripts };
