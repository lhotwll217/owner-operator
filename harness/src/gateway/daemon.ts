// Owner Operator — the daemon: ONE process that owns state, openclaw's gateway pattern
// sized for local-first v1. It owns the poll loop (scan + resolver +
// store), the schedule/trigger runner, and the push stream; surfaces (TUI, one-shot oo,
// future web/widget) are thin clients over the protocol in @owner-operator/core.
//
// MULTI-CONSUMER WRITING, final form: when the daemon runs, it is the ONLY writer — every
// surface mutates via HTTP here, and the store's own transactional safety (threads-db.ts)
// becomes defense-in-depth rather than the first line. Clients without a daemon fall back
// to the store seam (client.ts), which the write-boundary done-hold keeps correct.
//
// Transport: HTTP JSON + SSE on 127.0.0.1 only (no auth on purpose — localhost, same
// user; revisit before any non-loopback bind). Endpoints: see packages/core/src/protocol.ts.
//
//   oo daemon          → run it (logs to stderr; ~/.owner-operator/daemon.json = discovery)

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { execFile } from "node:child_process";
import { writeFileSync, rmSync } from "node:fs";
import {
  becameNeedsYou,
  DEFAULT_DAEMON_PORT,
  type DaemonEvent,
  type DaemonInfo,
  type Schedule,
  type ScheduleAction,
  type ScheduleWhen,
  type StatusDiff,
  type StatusSnapshot,
  type TriageInfo,
} from "@owner-operator/core";
import { StatusPoller, type PollerOptions } from "./poller";
import { DAEMON_FILE, loadTriage, markThreadsDone, renameThread, saveTriage, storeDb } from "./store";

export interface DaemonOptions {
  /** 0 = ephemeral (tests). Default: OO_PORT or 47711. */
  port?: number;
  /** Poller wiring — the scan seam makes the daemon fully testable. */
  poller?: PollerOptions;
  /** fs.watch the session dirs (default true; off in tests). */
  watch?: boolean;
  /** Scheduler cadence in ms (default 15s). */
  tickMs?: number;
}

export interface RunningDaemon {
  port: number;
  poller: StatusPoller;
  close(): Promise<void>;
}

/**
 * Is a time-based schedule due? Pure, so the calendar math is testable. `daily` fires once
 * after the local HH:MM passes; `event` schedules are never "due" — edges run them.
 */
export function isDue(when: ScheduleWhen, lastRunAt: string | undefined, now: Date): boolean {
  if (when.type === "interval") return !lastRunAt || now.getTime() - Date.parse(lastRunAt) >= when.ms;
  if (when.type === "daily") {
    const [hh, mm] = when.at.split(":").map(Number);
    const fire = new Date(now);
    fire.setHours(hh, mm, 0, 0);
    if (fire.getTime() > now.getTime()) return false;
    return !lastRunAt || Date.parse(lastRunAt) < fire.getTime();
  }
  return false;
}

const validWhen = (w: any): w is ScheduleWhen =>
  (w?.type === "interval" && Number.isInteger(w.ms) && w.ms >= 5_000) ||
  (w?.type === "daily" && /^\d{2}:\d{2}$/.test(w.at ?? "")) ||
  (w?.type === "event" && w.event === "needs-you");
const validAction = (a: any): a is ScheduleAction =>
  a?.type === "poll" || (a?.type === "shell" && typeof a.command === "string" && a.command.trim().length > 0);

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 1_000_000) { reject(new Error("body too large")); req.destroy(); }
    });
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error("invalid JSON")); }
    });
    req.on("error", reject);
  });
}

export async function startDaemon(opts: DaemonOptions = {}): Promise<RunningDaemon> {
  const db = storeDb();
  const poller = new StatusPoller(opts.poller);
  const sse = new Set<ServerResponse>();

  const broadcast = (e: DaemonEvent): void => {
    const frame = `data: ${JSON.stringify(e)}\n\n`;
    for (const res of sse) res.write(frame);
  };

  const runSchedule = async (s: Schedule, env: Record<string, string> = {}): Promise<{ ok: boolean; detail?: string }> => {
    let result: { ok: boolean; detail?: string };
    if (s.action.type === "poll") {
      result = (await poller.poll()) ? { ok: true } : { ok: false, detail: "poll failed" };
    } else {
      const command = s.action.command;
      result = await new Promise((resolve) => {
        execFile("/bin/sh", ["-c", command], {
          timeout: 60_000,
          env: { ...process.env, ...env },
        }, (err) => resolve(err ? { ok: false, detail: String(err.code ?? err.message) } : { ok: true }));
      });
    }
    db.recordScheduleRun(s.name, { ...result, at: new Date().toISOString() });
    broadcast({ type: "schedule_run", name: s.name, ok: result.ok, ...(result.detail ? { detail: result.detail } : {}) });
    return result;
  };

  // The push stream + event triggers hang off the poll: every pass broadcasts, and a
  // thread NEWLY needing the owner (transition or fresh appearance) fires event
  // schedules with OO_NEEDS_YOU=<ids> — a desktop notification is one shell command away.
  poller.subscribe((snapshot: StatusSnapshot, diff: StatusDiff) => {
    broadcast({ type: "snapshot", snapshot, diff });
    const newly = [...becameNeedsYou(diff), ...diff.appeared.filter((t) => t.state === "needs-you")];
    if (!newly.length) return;
    const env = { OO_NEEDS_YOU: newly.map((t) => t.id).join(",") };
    for (const s of db.listSchedules()) {
      if (s.enabled && s.when.type === "event" && s.when.event === "needs-you") void runSchedule(s, env);
    }
  });

  // Time-based runner: a coarse tick, due-check against last_run (persisted, so restarts
  // don't double-fire a daily and a missed window fires on the next tick).
  const tick = setInterval(() => {
    const now = new Date();
    for (const s of db.listSchedules()) {
      if (s.enabled && isDue(s.when, s.lastRunAt, now)) void runSchedule(s);
    }
  }, opts.tickMs ?? 15_000);
  tick.unref?.();

  const startedAt = new Date().toISOString();

  const server: Server = createServer(async (req, res) => {
    const respond = (status: number, body: unknown): void => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const route = `${req.method} ${url.pathname}`;
      const scheduleName = /^\/schedules\/([^/]+)/.exec(url.pathname)?.[1];

      if (route === "GET /health") {
        return respond(200, { ok: true, pid: process.pid, startedAt, polledAt: poller.current?.polledAt ?? null });
      }
      if (route === "GET /snapshot") return respond(200, poller.current ?? { polledAt: "", threads: [] });
      if (route === "GET /triage") return respond(200, Object.fromEntries(loadTriage()));
      if (route === "POST /poll") return respond(200, (await poller.poll()) ?? { polledAt: "", threads: [] });

      if (route === "POST /done") {
        const body = (await readBody(req)) as { ids?: unknown };
        if (!Array.isArray(body.ids) || !body.ids.every((x) => typeof x === "string")) {
          return respond(400, { error: "ids: string[] required" });
        }
        const result = markThreadsDone(body.ids);
        if (result.snapshot) {
          // Push the mark immediately (don't wait for the next pass), then reconcile soon.
          broadcast({ type: "snapshot", snapshot: result.snapshot, diff: { appeared: [], transitioned: result.marked, resolved: [] } });
          setTimeout(() => void poller.poll(), 0).unref?.();
        }
        return respond(200, result);
      }

      if (route === "POST /rename") {
        const body = (await readBody(req)) as { id?: unknown; title?: unknown };
        if (typeof body.id !== "string" || !body.id.trim() || typeof body.title !== "string") {
          return respond(400, { error: "id: string and title: string required (empty title clears the rename)" });
        }
        const snapshot = renameThread(body.id, body.title);
        if (!snapshot) return respond(404, { error: "no such thread" });
        // Push the rename immediately (same shape as /done): the stored truth, then surfaces refetch.
        broadcast({ type: "snapshot", snapshot, diff: { appeared: [], transitioned: [], resolved: [] } });
        setTimeout(() => void poller.poll(), 0).unref?.();
        return respond(200, { ok: true });
      }

      if (route === "POST /triage") {
        const body = (await readBody(req)) as { entries?: Record<string, TriageInfo> };
        if (!body.entries || typeof body.entries !== "object") return respond(400, { error: "entries required" });
        saveTriage(new Map(Object.entries(body.entries)));
        broadcast({ type: "triage", entries: body.entries });
        return respond(200, { ok: true });
      }

      if (route === "GET /events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        res.write(":ok\n\n");
        sse.add(res);
        req.on("close", () => sse.delete(res));
        return;
      }

      if (route === "GET /schedules") return respond(200, db.listSchedules());
      if (scheduleName && req.method === "PUT" && url.pathname === `/schedules/${scheduleName}`) {
        const body = (await readBody(req)) as { when?: unknown; action?: unknown; enabled?: unknown };
        if (!validWhen(body.when) || !validAction(body.action)) {
          return respond(400, { error: "when/action invalid — see packages/core/src/protocol.ts" });
        }
        return respond(200, db.upsertSchedule({
          name: scheduleName, when: body.when, action: body.action, enabled: body.enabled !== false,
        }));
      }
      if (scheduleName && req.method === "DELETE" && url.pathname === `/schedules/${scheduleName}`) {
        return respond(db.deleteSchedule(scheduleName) ? 200 : 404, { ok: true });
      }
      if (scheduleName && req.method === "POST" && url.pathname === `/schedules/${scheduleName}/run`) {
        const target = db.listSchedules().find((x) => x.name === scheduleName);
        if (!target) return respond(404, { error: "no such schedule" });
        return respond(200, await runSchedule(target));
      }

      return respond(404, { error: "unknown route" });
    } catch (e: any) {
      return respond(400, { error: e?.message ?? String(e) });
    }
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? (Number(process.env.OO_PORT) || DEFAULT_DAEMON_PORT), "127.0.0.1", () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr ? addr.port : 0);
    });
  });

  const info: DaemonInfo = { port, pid: process.pid, startedAt };
  try { writeFileSync(DAEMON_FILE, JSON.stringify(info, null, 2)); } catch { /* discovery is best-effort */ }

  poller.start();
  if (opts.watch !== false) poller.watch();

  return {
    port,
    poller,
    async close() {
      clearInterval(tick);
      poller.stop();
      for (const res of sse) { try { res.end(); } catch { /* closing */ } }
      sse.clear();
      try { rmSync(DAEMON_FILE, { force: true }); } catch { /* best-effort */ }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** `oo daemon` entry — runs until SIGINT/SIGTERM. */
export async function daemonMain(): Promise<void> {
  let daemon: RunningDaemon;
  try {
    daemon = await startDaemon();
  } catch (e: any) {
    if (e?.code === "EADDRINUSE") {
      console.error("[ood] another daemon is already listening (or the port is taken) — `oo daemon` runs one per box; set OO_PORT to move it.");
      process.exit(1);
    }
    throw e;
  }
  console.error(`[ood] owner-operator daemon · http://127.0.0.1:${daemon.port} · pid ${process.pid}`);
  await new Promise<void>((resolve) => {
    const stop = (): void => { void daemon.close().then(resolve); };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
