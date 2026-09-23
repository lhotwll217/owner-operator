import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { isAbsolute } from "node:path";
import {
  AgentRunHarness,
  DatabaseQueryAction,
  DEFAULT_AGENT_RUN_WAIT_SECONDS,
  DEFAULT_DAEMON_PORT,
  DomainEventKind,
  GatewayEventKind,
  MAX_AGENT_RUN_WAIT_SECONDS,
  isAgentRunEffort,
  isTerminalAgentRunStatus,
  validateAgentRunResumeTask,
  type AgentRun,
  type AgentRunCreateInput,
  type AgentRunLogRecord,
  type DaemonHealth,
  type DaemonReady,
  type DatabaseQueryRequest,
  type GatewayEvent,
  type HarnessDetailsRequest,
  type SessionSearchRequest,
  type SessionSearchResult,
  type ScheduleCreateInput,
  type ScheduleDefinition,
  type ScheduleRun,
  type ResolveWorktreeCwdRequest,
  type ResolveWorktreeCwdResult,
  type UseWorktreeRequest,
  type UseWorktreeResult,
} from "@owner-operator/core";
import type { ParentAgentStateView } from "@owner-operator/core/agent-state";
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
  view(parentThreadId?: string): ParentAgentStateView;
  get(id: string): AgentRun | undefined;
  launch(input: AgentRunCreateInput): AgentRun;
  cancel(id: string): Promise<AgentRun>;
  retry(id: string): AgentRun;
  resume(id: string, task: string): AgentRun;
  wait(id: string, timeoutSeconds: number): Promise<AgentRun>;
  /** The run's durable log after `afterSeq`, in order, read lazily; the terminal record closes it. */
  events(id: string, afterSeq: number): Iterable<{ seq: number; record: AgentRunLogRecord }>;
  /** The last sequence number ever issued for the run; null for a run finalized before logs existed. */
  lastSeq(id: string): number | null;
  /** Wake-up after a run's log grows; returns the unsubscribe. */
  subscribeLog(listener: (runId: string) => void): () => void;
}

export interface GatewayHarness {
  details(request: HarnessDetailsRequest): Promise<unknown>;
}

export interface GatewaySessionSearch {
  run(request: SessionSearchRequest): Promise<SessionSearchResult>;
}

export interface GatewayWorktrees {
  use(request: UseWorktreeRequest): Promise<UseWorktreeResult>;
  resolveCwd(request: ResolveWorktreeCwdRequest): Promise<ResolveWorktreeCwdResult>;
}

export interface GatewayOptions {
  authToken: string;
  state: State;
  monitor: GatewayMonitor;
  scheduler: GatewayScheduler;
  agentRuns: GatewayAgentRuns;
  worktrees: GatewayWorktrees;
  query: GatewayQueryService;
  harness: GatewayHarness;
  search: GatewaySessionSearch;
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
  const runLogStreams = new Set<ServerResponse>();
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
      if (route === "POST /poll") {
        const body = await readBody(request) as { reconcile?: unknown } | null;
        if (body === null || typeof body !== "object" || Array.isArray(body)) return respond(400, { error: "poll body must be an object" });
        const reconcile = body.reconcile ?? [];
        if (!Array.isArray(reconcile) || reconcile.length > 100 || !reconcile.every((item) =>
          item && typeof item.id === "string" && item.id.trim() &&
          typeof item.lastMessageAt === "string" && Number.isFinite(Date.parse(item.lastMessageAt)))) {
          return respond(400, { error: "reconcile must contain at most 100 id and lastMessageAt pairs" });
        }
        const queuedIds = options.state.requestEnrichment(reconcile);
        await options.monitor.poll();
        return respond(200, { ok: true, queuedIds });
      }

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
        return options.scheduler.deleteSchedule(scheduleId)
          ? respond(200, { ok: true })
          : respond(404, { error: `no such schedule: ${scheduleId}` });
      }
      if (scheduleId && request.method === "POST" && url.pathname === `/schedules/${scheduleId}/run`) {
        return respond(202, await options.scheduler.runNow(scheduleId));
      }

      if (route === "GET /agent-runs") {
        const parent = url.searchParams.get("parentThreadId");
        return respond(200, options.agentRuns.list(parent ?? undefined));
      }
      if (route === "GET /agent-state") {
        const parent = url.searchParams.get("parentThreadId");
        return respond(200, options.agentRuns.view(parent ?? undefined));
      }
      if (route === "POST /agent-runs") {
        const run = options.agentRuns.launch(await readBody(request) as AgentRunCreateInput);
        return respond(201, run);
      }
      if (agentRunId && request.method === "GET" && url.pathname === `/agent-runs/${agentRunId}`) {
        const run = options.agentRuns.get(agentRunId);
        return run ? respond(200, run) : respond(404, { error: "no such agent run" });
      }
      if (agentRunId && request.method === "GET" && url.pathname === `/agent-runs/${agentRunId}/events`) {
        if (!options.agentRuns.get(agentRunId)) return respond(404, { error: "no such agent run" });
        // Replays from the start (or after Last-Event-ID / ?after=) and tails to the terminal
        // record; ?follow=0 returns the log so far. Additive to GET /events, which is unchanged.
        const follow = url.searchParams.get("follow") !== "0";
        let after = Number(request.headers["last-event-id"] ?? url.searchParams.get("after") ?? 0);
        if (!Number.isSafeInteger(after) || after < 0) return respond(400, { error: "after must be a non-negative integer" });
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        let ended = false;
        let draining = false;
        let unsubscribe = (): void => undefined;
        const end = (): void => {
          if (ended) return;
          ended = true;
          unsubscribe();
          runLogStreams.delete(response);
          response.end();
        };
        // Write from SQLite until the socket reports backpressure, then wait for drain. Rows are
        // read lazily, so a slow reader holds at most one socket buffer of the log in memory.
        const pump = (): void => {
          if (ended || draining) return;
          for (const entry of options.agentRuns.events(agentRunId, after)) {
            const accepted = response.write(`id: ${entry.seq}\ndata: ${JSON.stringify(entry.record)}\n\n`);
            after = entry.seq;
            if (entry.record.type === "result") return end();
            if (!accepted) {
              draining = true;
              response.once("drain", () => { draining = false; pump(); });
              return;
            }
          }
          const run = options.agentRuns.get(agentRunId);
          if (run && isTerminalAgentRunStatus(run.status)) {
            // Only a run finalized before event logs existed lacks a stored terminal record; a
            // cursor already past a stored one simply ends without a duplicate.
            if (options.agentRuns.lastSeq(agentRunId) === null) {
              response.write(`data: ${JSON.stringify({
                type: "result", runId: run.id, status: run.status, ...(run.error ? { error: { message: run.error } } : {}),
              })}\n\n`);
            }
            return end();
          }
          if (!follow) return end();
        };
        runLogStreams.add(response);
        request.on("close", end);
        unsubscribe = options.agentRuns.subscribeLog((runId) => {
          if (runId === agentRunId) pump();
        });
        pump();
        return;
      }
      if (agentRunId && request.method === "POST" && url.pathname === `/agent-runs/${agentRunId}/cancel`) {
        return respond(200, await options.agentRuns.cancel(agentRunId));
      }
      if (agentRunId && request.method === "POST" && url.pathname === `/agent-runs/${agentRunId}/retry`) {
        return respond(201, options.agentRuns.retry(agentRunId));
      }
      if (agentRunId && request.method === "POST" && url.pathname === `/agent-runs/${agentRunId}/resume`) {
        const body = await readBody(request) as { task?: unknown };
        return respond(201, options.agentRuns.resume(
          agentRunId,
          validateAgentRunResumeTask(body.task),
        ));
      }
      if (agentRunId && request.method === "POST" && url.pathname === `/agent-runs/${agentRunId}/wait`) {
        const body = await readBody(request) as { timeoutSeconds?: unknown };
        const raw = body.timeoutSeconds;
        if (raw !== undefined &&
            (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0 || raw > MAX_AGENT_RUN_WAIT_SECONDS)) {
          return respond(400, { error: `timeoutSeconds must be an integer in 0..${MAX_AGENT_RUN_WAIT_SECONDS}` });
        }
        const timeoutSeconds = typeof raw === "number" ? raw : DEFAULT_AGENT_RUN_WAIT_SECONDS;
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

      if (route === "POST /harness-details") {
        const body = await readBody(request) as Record<string, unknown> | null;
        if (body === null || typeof body !== "object" || Array.isArray(body)) {
          return respond(400, { error: "harness details body must be an object" });
        }
        const harnesses = body.harnesses ?? [];
        const inspect = body.inspect ?? [];
        const known = (value: unknown): boolean => Object.values(AgentRunHarness).includes(value as AgentRunHarness);
        if (!Array.isArray(harnesses) || !harnesses.every(known)) {
          return respond(400, { error: `harnesses must be supported harness ids: ${Object.values(AgentRunHarness).join(", ")}` });
        }
        if (!Array.isArray(inspect) || !inspect.every((entry) =>
          entry && typeof entry === "object" && known(entry.harness) &&
          typeof entry.model === "string" && entry.model.trim() &&
          (entry.effort === null || isAgentRunEffort(entry.effort)))) {
          return respond(400, { error: "inspect entries need a supported harness, an exact model, and an effort or null" });
        }
        if (body.includeBaselineCandidates !== undefined && typeof body.includeBaselineCandidates !== "boolean") {
          return respond(400, { error: "includeBaselineCandidates must be a boolean" });
        }
        return respond(200, await options.harness.details(body as HarnessDetailsRequest));
      }

      if (route === "POST /session-search") {
        const body = await readBody(request) as Record<string, unknown> | null;
        const optionalId = (value: unknown): boolean => value === undefined || value === null || typeof value === "string";
        if (body === null || typeof body !== "object" || Array.isArray(body) ||
            !Array.isArray(body.args) || !body.args.every((arg) => typeof arg === "string") ||
            !optionalId(body.callerSessionId) || !optionalId(body.currentSessionId) ||
            (body.cwd !== undefined && (typeof body.cwd !== "string" || !isAbsolute(body.cwd)))) {
          return respond(400, { error: "session search needs string args, optional string session ids, and an absolute cwd" });
        }
        return respond(200, await options.search.run(body as unknown as SessionSearchRequest));
      }

      if (route === "POST /worktrees/use") {
        return respond(200, await options.worktrees.use(await readBody(request) as UseWorktreeRequest));
      }

      if (route === "GET /worktrees/resolve-cwd") {
        return respond(200, await options.worktrees.resolveCwd(
          {
            threadId: url.searchParams.get("threadId"),
            fallbackCwd: url.searchParams.get("fallbackCwd"),
          } as ResolveWorktreeCwdRequest,
        ));
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
      for (const stream of runLogStreams) stream.end();
      runLogStreams.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
