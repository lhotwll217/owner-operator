import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import {
  type DaemonHealth,
  type DaemonInfo,
  type DaemonReady,
  ensureOwnerOperatorWorkspace,
  isOnboarded,
} from "@owner-operator/core";
import { startGateway, type RunningGateway } from "../gateway/server";
import { SessionMonitor, type SessionMonitorOptions } from "../session-monitor/monitor";
import { sampleTranscript } from "../session-monitor/scan";
import { Scheduler, type SchedulerOptions } from "../scheduler/scheduler";
import { describeTable, listTables, runQuery } from "../state/query";
import { State } from "../state/state";
import { daemonInfoPath, stateDatabasePath } from "../shared/paths";
import { runtimeFingerprint } from "./fingerprint";

export interface DaemonOptions {
  port?: number;
  dbPath?: string;
  monitor?: SessionMonitorOptions;
  scheduler?: SchedulerOptions;
  watch?: boolean;
  fingerprintIntervalMs?: number;
  enableEnrichment?: boolean;
  onStale?: () => void;
}

export interface RunningDaemon {
  port: number;
  fingerprint: string;
  state: State;
  monitor: SessionMonitor;
  scheduler: Scheduler;
  close(): Promise<void>;
}

export async function startDaemon(options: DaemonOptions = {}): Promise<RunningDaemon> {
  ensureOwnerOperatorWorkspace();
  const dbPath = options.dbPath ?? stateDatabasePath();
  const startedAt = new Date().toISOString();
  const fingerprint = runtimeFingerprint();
  const authToken = randomBytes(32).toString("base64url");
  let stale = false;
  let closed = false;
  const modules: DaemonReady["modules"] = {
    state: false, sessionMonitor: false, scheduler: false, gateway: false,
  };

  const state = new State(dbPath);
  modules.state = true;
  const monitor = new SessionMonitor(state, {
    ...options.monitor,
    canEnrich: options.monitor?.canEnrich ?? (() => isOnboarded()),
    logger: options.monitor?.logger ?? ((record) => {
      process.stderr.write(`${JSON.stringify({ component: "session-monitor", ...record })}\n`);
    }),
    ...(options.enableEnrichment === false
      ? { enrich: undefined }
      : { enrich: options.monitor?.enrich ?? (async (candidate) =>
          (await import("../agent/enrichment")).enrichThread(await sampleTranscript(candidate.id))) }),
  });
  modules.sessionMonitor = true;
  const scheduler = new Scheduler(state, {
    ...options.scheduler,
    logger: options.scheduler?.logger ?? ((record) => {
      process.stderr.write(`${JSON.stringify({ component: "scheduler", ...record })}\n`);
    }),
    promptRunner: options.scheduler?.promptRunner ?? (async (request) =>
      (await import("../agent/agent")).runScheduledPrompt(request)),
  });
  modules.scheduler = true;

  const health = (): DaemonHealth => ({
    ok: true, port: gateway.port, pid: process.pid, startedAt, fingerprint, stale,
  });
  const ready = (): DaemonReady => ({
    ready: Object.values(modules).every(Boolean) && !stale,
    setupRequired: !isOnboarded(),
    modules: { ...modules },
  });

  let gateway: RunningGateway = { port: 0, close: async () => undefined };
  gateway = await startGateway({
    authToken,
    state,
    monitor,
    scheduler,
    port: options.port,
    health,
    ready,
    query: {
      listTables: () => listTables(dbPath),
      describeTable: (table) => describeTable(table, dbPath),
      query: (sql) => runQuery(sql, dbPath),
    },
  });
  modules.gateway = true;

  const info: DaemonInfo = { port: gateway.port, pid: process.pid, startedAt, fingerprint, authToken };
  mkdirSync(dirname(daemonInfoPath()), { recursive: true });
  writeFileSync(daemonInfoPath(), JSON.stringify(info, null, 2), { mode: 0o600 });
  chmodSync(daemonInfoPath(), 0o600);

  scheduler.start();
  monitor.start();
  if (options.watch !== false) monitor.watch();

  const fingerprintTimer = setInterval(() => {
    if (!stale && runtimeFingerprint() !== fingerprint) {
      stale = true;
      options.onStale?.();
    }
  }, options.fingerprintIntervalMs ?? 2_000);
  fingerprintTimer.unref?.();

  return {
    port: gateway.port,
    fingerprint,
    state,
    monitor,
    scheduler,
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(fingerprintTimer);
      monitor.stop();
      await scheduler.stop();
      await gateway.close();
      state.close();
      try { rmSync(daemonInfoPath(), { force: true }); } catch { /* best effort */ }
    },
  };
}

export async function daemonMain(): Promise<void> {
  let daemon: RunningDaemon;
  try {
    daemon = await startDaemon({ onStale: () => process.kill(process.pid, "SIGTERM") });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      process.stderr.write("oo: another daemon already owns the loopback port\n");
      process.exitCode = 1;
      return;
    }
    throw error;
  }
  process.stderr.write(`[ood] ready at http://127.0.0.1:${daemon.port} · pid ${process.pid}\n`);
  await new Promise<void>((resolve) => {
    const stop = (): void => { void daemon.close().then(resolve); };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
