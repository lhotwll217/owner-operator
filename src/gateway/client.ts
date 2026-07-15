import { readFileSync } from "node:fs";
import {
  type DaemonHealth,
  type DaemonInfo,
  type DaemonReady,
  type DatabaseQueryRequest,
  type DatabaseQueryResponse,
  type GatewayApi,
  type GatewayEvent,
  type MarkThreadsDoneResult,
  type ScheduleCreateInput,
  type ScheduleDefinition,
  type ScheduleRun,
  type SessionStateRow,
} from "@owner-operator/core";
import { daemonInfoPath } from "../shared/paths";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const FAST_REQUEST_MS = 2_000;
const MUTATION_REQUEST_MS = 10_000;
const LONG_OPERATION_MS = 60_000;
let memo: Promise<GatewayApi> | null = null;

export interface GatewayProbe {
  info: DaemonInfo;
  health: DaemonHealth;
  ready: DaemonReady;
}

function readDaemonInfo(): DaemonInfo | null {
  try { return JSON.parse(readFileSync(daemonInfoPath(), "utf8")) as DaemonInfo; } catch { return null; }
}

function daemonIdentityOrCredentialChanged(current: DaemonInfo, next: DaemonInfo): boolean {
  return current.port !== next.port
    || current.pid !== next.pid
    || current.startedAt !== next.startedAt
    || current.fingerprint !== next.fingerprint
    || current.authToken !== next.authToken;
}

interface GatewayJsonOptions {
  init?: RequestInit;
  timeoutMs?: number;
  acceptStatuses?: readonly number[];
  onUnavailable?: () => void;
}

async function gatewayJson<T>(
  info: DaemonInfo,
  path: string,
  options: GatewayJsonOptions = {},
): Promise<T> {
  const request = async (requestInfo: DaemonInfo): Promise<Response> => {
    const headers = new Headers(options.init?.headers);
    headers.set("authorization", `Bearer ${requestInfo.authToken}`);
    try {
      return await fetch(`http://127.0.0.1:${requestInfo.port}${path}`, {
        ...options.init,
        headers,
        signal: options.init?.signal ?? AbortSignal.timeout(options.timeoutMs ?? FAST_REQUEST_MS),
      });
    } catch (error) {
      options.onUnavailable?.();
      throw error;
    }
  };
  const accepted = (response: Response): boolean => response.ok || options.acceptStatuses?.includes(response.status) === true;

  let response = await request(info);
  if (!accepted(response) && response.status === 401) {
    options.onUnavailable?.();
    const next = readDaemonInfo();
    if (next?.authToken && daemonIdentityOrCredentialChanged(info, next)) {
      response = await request(next);
      if (!accepted(response) && response.status === 401) options.onUnavailable?.();
    }
  }
  if (!accepted(response)) throw new Error(`gateway ${path}: ${response.status}`);
  return await response.json() as T;
}

/** Authenticated identity probe, including a daemon that is alive but not ready. */
export async function probeGateway(): Promise<GatewayProbe | null> {
  const info = readDaemonInfo();
  if (!info?.authToken) return null;
  try {
    const health = await gatewayJson<DaemonHealth>(info, "/health");
    const ready = await gatewayJson<DaemonReady>(info, "/ready", { acceptStatuses: [503] });
    if (health.pid !== info.pid || health.fingerprint !== info.fingerprint) return null;
    return { info, health, ready };
  } catch {
    return null;
  }
}

/** Connect only to a ready daemon whose discovery file and health response agree. */
export async function connectGateway(onUnavailable: () => void = () => undefined): Promise<GatewayApi | null> {
  const probe = await probeGateway();
  if (!probe?.ready.ready) return null;
  const { info } = probe;

  const json = <T>(path: string, init?: RequestInit, timeoutMs = FAST_REQUEST_MS): Promise<T> =>
    gatewayJson<T>(info, path, { init, timeoutMs, onUnavailable });
  const post = <T>(path: string, body: unknown, timeoutMs = MUTATION_REQUEST_MS): Promise<T> =>
    gatewayJson<T>(info, path, {
      timeoutMs,
      onUnavailable,
      init: {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    });
  const subscriptions = new Set<() => void>();

  return {
    health: () => json<DaemonHealth>("/health"),
    ready: () => json<DaemonReady>("/ready"),
    sessionState: () => json<SessionStateRow[]>("/session-state"),
    markDone: (ids) => post<MarkThreadsDoneResult>("/done", { ids }),
    renameThread: async (id, title) => { await post("/rename", { id, title }); },
    poll: async () => { await post("/poll", {}, LONG_OPERATION_MS); },
    listSchedules: () => json<ScheduleDefinition[]>("/schedules"),
    createSchedule: (input: ScheduleCreateInput) => post<ScheduleDefinition>("/schedules", input),
    updateSchedule: (id: string, input: ScheduleCreateInput) => json<ScheduleDefinition>(
      `/schedules/${encodeURIComponent(id)}`,
      { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(input) },
    ),
    deleteSchedule: async (id: string) => {
      await json(`/schedules/${encodeURIComponent(id)}`, { method: "DELETE" });
    },
    runSchedule: (id: string) => post<ScheduleRun>(`/schedules/${encodeURIComponent(id)}/run`, {}),
    queryDatabase: (request: DatabaseQueryRequest) => post<DatabaseQueryResponse>(
      "/query-database",
      request,
      LONG_OPERATION_MS,
    ),
    subscribe(listener: (event: GatewayEvent) => void) {
      let stopped = false;
      const controller = new AbortController();
      void (async () => {
        while (!stopped) {
          try {
            const eventInfo = readDaemonInfo();
            if (!eventInfo?.authToken) throw new Error("gateway discovery is unavailable");
            const response = await fetch(`http://127.0.0.1:${eventInfo.port}/events`, {
              headers: { authorization: `Bearer ${eventInfo.authToken}` },
              signal: controller.signal,
            });
            if (!response.ok) {
              if (response.status === 401) onUnavailable();
              throw new Error(`gateway /events: ${response.status}`);
            }
            const reader = response.body?.getReader();
            if (!reader) throw new Error("gateway event stream has no body");
            const decoder = new TextDecoder();
            let buffer = "";
            for (;;) {
              const chunk = await reader.read();
              if (chunk.done) break;
              buffer += decoder.decode(chunk.value, { stream: true });
              let boundary = buffer.indexOf("\n\n");
              while (boundary !== -1) {
                const frame = buffer.slice(0, boundary);
                buffer = buffer.slice(boundary + 2);
                for (const line of frame.split("\n")) {
                  if (!line.startsWith("data: ")) continue;
                  try { listener(JSON.parse(line.slice(6)) as GatewayEvent); } catch { /* malformed frame */ }
                }
                boundary = buffer.indexOf("\n\n");
              }
            }
          } catch {
            // The daemon may be replacing itself; reconnect until this client closes.
          }
          if (!stopped) await sleep(1_000);
        }
      })();
      const stop = (): void => { stopped = true; controller.abort(); subscriptions.delete(stop); };
      subscriptions.add(stop);
      return stop;
    },
    close() {
      for (const stop of subscriptions) stop();
    },
  };
}

/** Production surfaces require the daemon; there is deliberately no embedded-store mode. */
export function resolveBackend(): Promise<GatewayApi> {
  if (memo) return memo;
  let candidate: Promise<GatewayApi>;
  candidate = connectGateway(() => {
    if (memo === candidate) memo = null;
  }).then((gateway) => {
    if (!gateway) throw new Error("Owner Operator daemon is not ready");
    return gateway;
  }).catch((error) => {
    if (memo === candidate) memo = null;
    throw error;
  });
  memo = candidate;
  return candidate;
}
