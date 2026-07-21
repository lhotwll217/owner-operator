import type { AgentRun, AgentRunCreateInput } from "./agent-runs";
import type { ParentAgentStateView } from "./agent-state";
import type { GatewayEvent } from "./events";
import type { ScheduleCreateInput, ScheduleDefinition, ScheduleRun } from "./scheduling";
import type { ThreadState } from "./status";

export const DEFAULT_DAEMON_PORT = 47711;

export interface DaemonInfo {
  port: number;
  pid: number;
  startedAt: string;
  fingerprint: string;
  authToken: string;
}

export interface DaemonHealth {
  ok: true;
  port: number;
  pid: number;
  startedAt: string;
  fingerprint: string;
  stale: boolean;
}

export interface DaemonReady {
  ready: boolean;
  setupRequired: boolean;
  modules: {
    state: boolean;
    sessionMonitor: boolean;
    scheduler: boolean;
    gateway: boolean;
  };
}

/** Stable client projection. SQLite-specific fields stay behind the state seam. */
export interface SessionStateRow {
  id: string;
  source: string;
  repo: string;
  app: string;
  topic: string;
  generatedTopic: string;
  ownerTitle: string | null;
  summary: string | null;
  nextSteps: string | null;
  priority: number | null;
  state: ThreadState;
  stateReason: string | null;
  stateSince: string;
  lastActive: string;
  lastActiveAt: string | null;
  createdAt: string | null;
  lastMessageAt: string | null;
  diffAdded: number | null;
  diffDeleted: number | null;
  /** Set when this thread is a delegated run's child session: the delegating thread's id. */
  parentThreadId: string | null;
}

export interface EnrichmentCandidate extends SessionStateRow {
  enrichedThroughMessageAt: string | null;
}

export interface MarkThreadsDoneResult {
  marked: SessionStateRow[];
  alreadyDoneIds: string[];
  missingIds: string[];
}

export enum DatabaseQueryAction {
  ListTables = "list_tables",
  DescribeTable = "describe_table",
  Query = "query",
}

export type DatabaseQueryRequest =
  | { action: DatabaseQueryAction.ListTables }
  | { action: DatabaseQueryAction.DescribeTable; table: string }
  | { action: DatabaseQueryAction.Query; sql: string };

export type DatabaseQueryResponse = unknown;

export interface GatewayApi {
  health(): Promise<DaemonHealth>;
  ready(): Promise<DaemonReady>;
  sessionState(): Promise<SessionStateRow[]>;
  markDone(ids: readonly string[]): Promise<MarkThreadsDoneResult>;
  renameThread(id: string, title: string): Promise<void>;
  poll(): Promise<void>;
  listSchedules(): Promise<ScheduleDefinition[]>;
  createSchedule(input: ScheduleCreateInput): Promise<ScheduleDefinition>;
  updateSchedule(id: string, input: ScheduleCreateInput): Promise<ScheduleDefinition>;
  deleteSchedule(id: string): Promise<void>;
  runSchedule(id: string): Promise<ScheduleRun>;
  /** Shared, surface-independent delegated-run presentation derived from durable rows. */
  agentState(parentThreadId?: string): Promise<ParentAgentStateView>;
  listAgentRuns(parentThreadId?: string): Promise<AgentRun[]>;
  agentRun(id: string): Promise<AgentRun>;
  delegateAgent(input: AgentRunCreateInput): Promise<AgentRun>;
  cancelAgentRun(id: string): Promise<AgentRun>;
  resumeAgentRun(id: string): Promise<AgentRun>;
  waitAgentRun(id: string, timeoutSeconds: number): Promise<AgentRun>;
  queryDatabase(request: DatabaseQueryRequest): Promise<DatabaseQueryResponse>;
  /** `onConnected` fires after each initial or replacement SSE connection is established. */
  subscribe(listener: (event: GatewayEvent) => void, onConnected?: () => void): () => void;
  close(): void;
}

export type { GatewayEvent } from "./events";
