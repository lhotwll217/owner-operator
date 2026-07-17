import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import {
  DatabaseQueryAction,
  DEFAULT_DAEMON_PORT,
  DomainEventKind,
  GatewayEventKind,
  type AgentRun,
  type AgentRunCreateInput,
  type DaemonHealth,
  type DaemonReady,
  type DatabaseQueryRequest,
  type GatewayEvent,
  type ScheduleCreateInput,
  type ScheduleDefinition,
  type ScheduleRun,
} from "@owner-operator/core";
import type { State } from "../state/state";

export interface GatewayMonitor {
  poll(): Promise<unknown>;
}

export interface GatewayScheduler {
  listSchedules(): ScheduleDefinition[];
  createSchedule(input: ScheduleCreateInput): ScheduleDefinition;
  updateSchedule(id: string, input: ScheduleCreateInput): ScheduleDefinition;
  deleteSchedule(id: string): boolean;
  runNow(id: string): Promise<ScheduleRun>;
}

export interface GatewayQueryService {
  listTables(): unknown;
  describeTable(table: string): unknown;
  query(sql: string): unknown;
}

export interface GatewayAgentRuns {
  list(parentThreadId?: string): AgentRun[];
  get(id: string): AgentRun | undefined;
  launch(input: AgentRunCreateInput): AgentRun;
  cancel(id: string): Promise<AgentRun>;
  resume(id: string): AgentRun;
  wait(id: string, timeoutSeconds: number): Promise<AgentRun>;
}

export interface GatewayOptions {
  authToken: string;
  state: State;
  monitor: GatewayMonitor;
  scheduler: GatewayScheduler;
  agentRuns: GatewayAgentRuns;
  query: GatewayQueryService;
  health: () => DaemonHealth;
  ready: () => DaemonReady;
  port?: number;
}

export interface RunningGateway {
  port: number;
  close(): Promise<void>;
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += String(chunk);
      if (raw.length > 1_000_000) reject(new Error("request body too large"));
    });
    request.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error("invalid JSON")); }
    });
    request.on("error", reject);
  });
}

const invalidationFor = (kind: DomainEventKind): GatewayEvent => {
  if (kind === DomainEventKind.ScheduleChanged) return { kind: GatewayEventKind.ScheduleChanged };
  if (kind === DomainEventKind.ScheduleRunChanged) return { kind: GatewayEventKind.ScheduleRunChanged };
  if (kind === DomainEventKind.AgentRunChanged) return { kind: GatewayEventKind.AgentRunChanged };
  return { kind: GatewayEventKind.StateChanged };
};

function hasValidAuthorization(header: string | undefined, authToken: string): boolean {
  const digest = (value: string): Buffer => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(header ?? ""), digest(`Bearer ${authToken}`));
}

/** Loopback transport only: all behavior is delegated through injected public seams. */
export async function startGateway(options: GatewayOptions): Promise<RunningGateway> {
  const streams = new Set<ServerResponse>();
  const broadcast = (event: GatewayEvent): void => {
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const stream of streams) stream.write(frame);
  };
  const unsubscribe = options.state.bus.subscribe((event) => broadcast(invalidationFor(event.kind)));

  const server: Server = createServer(async (request, response) => {
    const respond = (status: number, body: unknown): void => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    try {
      if (!hasValidAuthorization(request.headers.authorization, options.authToken)) {
        response.setHeader("www-authenticate", "Bearer");
        return respond(401, { error: "unauthorized" });
      }
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const route = `${request.method} ${url.pathname}`;
      const scheduleId = /^\/schedules\/([^/]+)/.exec(url.pathname)?.[1];
      const agentRunId = /^\/agent-runs\/([^/]+)/.exec(url.pathname)?.[1];

      if (route === "GET /health") return respond(200, options.health());
      if (route === "GET /ready") {
        const readiness = options.ready();
        return respond(readiness.ready ? 200 : 503, readiness);
      }
      if (route === "GET /session-state") return respond(200, options.state.listCurrentSessionState());
      if (route === "POST /poll") { await options.monitor.poll(); return respond(200, { ok: true }); }

      if (route === "POST /done") {
        const body = await readBody(request) as { ids?: unknown };
        if (!Array.isArray(body.ids) || !body.ids.every((id) => typeof id === "string")) {
          return respond(400, { error: "ids must be a string array" });
        }
        return respond(200, options.state.markThreadsDone(body.ids));
      }

      if (route === "POST /rename") {
        const body = await readBody(request) as { id?: unknown; title?: unknown };
        if (typeof body.id !== "string" || typeof body.title !== "string") {
          return respond(400, { error: "id and title must be strings" });
        }
        return options.state.renameThread(body.id, body.title)
          ? respond(200, { ok: true })
          : respond(404, { error: "no such thread" });
      }

      if (route === "GET /events") {
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        response.write(":ready\n\n");
        streams.add(response);
        request.on("close", () => streams.delete(response));
        return;
      }

      if (route === "GET /schedules") return respond(200, options.scheduler.listSchedules());
      if (route === "POST /schedules") {
        return respond(201, options.scheduler.createSchedule(await readBody(request) as ScheduleCreateInput));
      }
      if (scheduleId && request.method === "PUT" && url.pathname === `/schedules/${scheduleId}`) {
        return respond(200, options.scheduler.updateSchedule(scheduleId, await readBody(request) as ScheduleCreateInput));
      }
      if (scheduleId && request.method === "DELETE" && url.pathname === `/schedules/${scheduleId}`) {
        return respond(options.scheduler.deleteSchedule(scheduleId) ? 200 : 404, { ok: true });
      }
      if (scheduleId && request.method === "POST" && url.pathname === `/schedules/${scheduleId}/run`) {
        return respond(202, await options.scheduler.runNow(scheduleId));
      }

      if (route === "GET /agent-runs") {
        const parent = url.searchParams.get("parentThreadId");
        return respond(200, options.agentRuns.list(parent ?? undefined));
      }
      if (route === "POST /agent-runs") {
        const run = options.agentRuns.launch(await readBody(request) as AgentRunCreateInput);
        return respond(201, run);
      }
      if (agentRunId && request.method === "GET" && url.pathname === `/agent-runs/${agentRunId}`) {
        const run = options.agentRuns.get(agentRunId);
        return run ? respond(200, run) : respond(404, { error: "no such agent run" });
      }
      if (agentRunId && request.method === "POST" && url.pathname === `/agent-runs/${agentRunId}/cancel`) {
        return respond(200, await options.agentRuns.cancel(agentRunId));
      }
      if (agentRunId && request.method === "POST" && url.pathname === `/agent-runs/${agentRunId}/resume`) {
        return respond(201, options.agentRuns.resume(agentRunId));
      }
      if (agentRunId && request.method === "POST" && url.pathname === `/agent-runs/${agentRunId}/wait`) {
        const body = await readBody(request) as { timeoutSeconds?: unknown };
        const timeoutSeconds = typeof body.timeoutSeconds === "number" ? body.timeoutSeconds : 60;
        return respond(200, await options.agentRuns.wait(agentRunId, timeoutSeconds));
      }

      if (route === "POST /query-database") {
        const query = await readBody(request) as DatabaseQueryRequest;
        if (query.action === DatabaseQueryAction.ListTables) return respond(200, options.query.listTables());
        if (query.action === DatabaseQueryAction.DescribeTable && typeof query.table === "string") {
          return respond(200, options.query.describeTable(query.table));
        }
        if (query.action === DatabaseQueryAction.Query && typeof query.sql === "string") {
          return respond(200, options.query.query(query.sql));
        }
        return respond(400, { error: "invalid database query request" });
      }

      return respond(404, { error: "unknown route" });
    } catch (error) {
      return respond(400, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? (Number(process.env.OO_PORT) || DEFAULT_DAEMON_PORT), "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });

  return {
    port,
    async close() {
      unsubscribe();
      for (const stream of streams) stream.end();
      streams.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
