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

/** Connect only to a ready daemon whose discovery file and health response agree. */
export async function connectGateway(): Promise<GatewayApi | null> {
  let info: DaemonInfo;
  try { info = JSON.parse(readFileSync(daemonInfoPath(), "utf8")) as DaemonInfo; } catch { return null; }
  const base = `http://127.0.0.1:${info.port}`;
  if (!info.authToken) return null;

  const json = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${info.authToken}`);
    const response = await fetch(base + path, {
      ...init,
      headers,
      signal: init?.signal ?? AbortSignal.timeout(2_000),
    });
    if (!response.ok) throw new Error(`gateway ${path}: ${response.status}`);
    return await response.json() as T;
  };
  try {
    const health = await json<DaemonHealth>("/health");
    const ready = await json<DaemonReady>("/ready");
    if (health.pid !== info.pid || health.fingerprint !== info.fingerprint || !ready.ready) return null;
  } catch {
    return null;
  }

  const post = <T>(path: string, body: unknown): Promise<T> => json<T>(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const subscriptions = new Set<() => void>();

  return {
    health: () => json<DaemonHealth>("/health"),
    ready: () => json<DaemonReady>("/ready"),
    sessionState: () => json<SessionStateRow[]>("/session-state"),
    markDone: (ids) => post<MarkThreadsDoneResult>("/done", { ids }),
    renameThread: async (id, title) => { await post("/rename", { id, title }); },
    poll: async () => { await post("/poll", {}); },
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
    queryDatabase: (request: DatabaseQueryRequest) => post<DatabaseQueryResponse>("/query-database", request),
    subscribe(listener: (event: GatewayEvent) => void) {
      let stopped = false;
      const controller = new AbortController();
      void (async () => {
        while (!stopped) {
          try {
            const response = await fetch(`${base}/events`, {
              headers: { authorization: `Bearer ${info.authToken}` },
              signal: controller.signal,
            });
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

let memo: Promise<GatewayApi> | null = null;

/** Production surfaces require the daemon; there is deliberately no embedded-store mode. */
export function resolveBackend(): Promise<GatewayApi> {
  memo ??= connectGateway().then((gateway) => {
    if (!gateway) throw new Error("Owner Operator daemon is not ready");
    return gateway;
  }).catch((error) => {
    memo = null;
    throw error;
  });
  return memo;
}
