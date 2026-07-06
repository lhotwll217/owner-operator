// Owner Operator — daemon client + the Backend seam surfaces program against.
//
// resolveBackend() is how a surface gets at state without caring who owns it:
//   • daemon running (discovered via daemon.json + /health) → thin HTTP/SSE client; the
//     daemon is the ONLY writer and pushes snapshots, so the surface runs no poller.
//   • no daemon → the store seam directly (embedded mode); the caller runs its own
//     poller, and the store's write-boundary done-hold keeps that mode safe too.
// OO_DAEMON=0 forces embedded mode (escape hatch).

import { spawn } from "node:child_process";
import { mkdirSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DaemonEvent, DaemonInfo, StatusSnapshot, TriageInfo } from "@owner-operator/core";
import {
  DAEMON_FILE,
  STORE_DIR,
  loadSnapshot,
  loadTriage,
  markThreadsDone,
  saveTriage,
  type MarkThreadsDoneResult,
} from "./store";

import { repoRoot } from "./repo-root";

/** What a surface needs from state, daemon- or store-backed. All ops async to keep one shape. */
export interface Backend {
  kind: "daemon" | "store";
  loadSnapshot(): Promise<StatusSnapshot | null>;
  loadTriage(): Promise<Map<string, TriageInfo>>;
  markThreadsDone(ids: readonly string[]): Promise<MarkThreadsDoneResult>;
  saveTriage(triage: ReadonlyMap<string, TriageInfo>): Promise<void>;
  /** Force a reconcile pass now. Store mode: no-op — the caller owns its poller. */
  forcePoll(): Promise<void>;
  /** Daemon push (SSE, auto-reconnect). Absent on the store backend. */
  subscribe?(fn: (e: DaemonEvent) => void): () => void;
  close(): void;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Probe the discovery file + /health. Null = no live daemon (stale file included). */
export async function connectDaemon(): Promise<Backend | null> {
  let info: DaemonInfo;
  try {
    info = JSON.parse(readFileSync(DAEMON_FILE, "utf8")) as DaemonInfo;
  } catch {
    return null;
  }
  const base = `http://127.0.0.1:${info.port}`;
  try {
    const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(500) });
    if (!health.ok) return null;
  } catch {
    return null;
  }

  const json = async (path: string, init?: RequestInit): Promise<any> => {
    const res = await fetch(base + path, init);
    if (!res.ok) throw new Error(`daemon ${path}: ${res.status}`);
    return res.json();
  };
  const post = (path: string, body: unknown): Promise<any> =>
    json(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  const stops = new Set<() => void>();
  return {
    kind: "daemon",
    async loadSnapshot() {
      const snap = (await json("/snapshot")) as StatusSnapshot;
      return snap.polledAt ? snap : null;
    },
    async loadTriage() {
      return new Map(Object.entries((await json("/triage")) as Record<string, TriageInfo>));
    },
    async markThreadsDone(ids) {
      return (await post("/done", { ids })) as MarkThreadsDoneResult;
    },
    async saveTriage(triage) {
      await post("/triage", { entries: Object.fromEntries(triage) });
    },
    async forcePoll() {
      await post("/poll", {});
    },
    subscribe(fn) {
      // One SSE connection per subscription; parse `data:` frames; reconnect until stopped.
      let stopped = false;
      const ctrl = new AbortController();
      void (async () => {
        while (!stopped) {
          try {
            const res = await fetch(`${base}/events`, { signal: ctrl.signal });
            const reader = res.body!.getReader();
            const dec = new TextDecoder();
            let buf = "";
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              buf += dec.decode(value, { stream: true });
              let i: number;
              while ((i = buf.indexOf("\n\n")) !== -1) {
                const frame = buf.slice(0, i);
                buf = buf.slice(i + 2);
                for (const line of frame.split("\n")) {
                  if (!line.startsWith("data: ")) continue;
                  try { fn(JSON.parse(line.slice(6)) as DaemonEvent); } catch { /* skip bad frame */ }
                }
              }
            }
          } catch { /* connection dropped */ }
          if (!stopped) await sleep(1_000);
        }
      })();
      const stop = (): void => { stopped = true; ctrl.abort(); stops.delete(stop); };
      stops.add(stop);
      return stop;
    },
    close() {
      for (const stop of stops) stop(); // Set iteration tolerates stop() deleting itself
    },
  };
}

// Detached spawn of `oo daemon` via the launcher (works from the repo and an npm-linked
// install); output lands in ~/.owner-operator/daemon.log. The daemon outlives this process.
function spawnDaemon(): void {
  mkdirSync(STORE_DIR, { recursive: true });
  const log = openSync(join(STORE_DIR, "daemon.log"), "a");
  const child = spawn(join(repoRoot, "harness", "oo"), ["daemon"], {
    detached: true,
    stdio: ["ignore", log, log],
  });
  child.unref();
}

function storeBackend(): Backend {
  return {
    kind: "store",
    loadSnapshot: async () => loadSnapshot(),
    loadTriage: async () => loadTriage(),
    markThreadsDone: async (ids) => markThreadsDone(ids),
    saveTriage: async (triage) => { saveTriage(triage); },
    forcePoll: async () => { /* embedded surfaces own their poller */ },
    close: () => { /* nothing held */ },
  };
}

let memo: Promise<Backend> | null = null;

/**
 * The one entry point surfaces use. Memoized per process — the TUI resolves first (and may
 * spawn the daemon); agent tools reuse whatever it found.
 */
export function resolveBackend(opts: { spawnDaemon?: boolean } = {}): Promise<Backend> {
  memo ??= (async (): Promise<Backend> => {
    if (process.env.OO_DAEMON === "0") return storeBackend();
    let daemon = await connectDaemon();
    if (!daemon && opts.spawnDaemon) {
      try { spawnDaemon(); } catch { /* launcher missing → embedded */ }
      for (let i = 0; !daemon && i < 8; i++) {
        await sleep(250);
        daemon = await connectDaemon();
      }
    }
    return daemon ?? storeBackend();
  })();
  return memo;
}
