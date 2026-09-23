import type { AgentRun, AgentRunCreateInput, AgentRunEffort, AgentRunHarness } from "./agent-runs";
import type { ParentAgentStateView } from "./agent-state";
import type { GatewayEvent } from "./events";
import type { ScheduleCreateInput, ScheduleDefinition, ScheduleRun } from "./scheduling";
import type { ThreadState } from "./status";
import type {
  ResolveWorktreeCwdRequest,
  ResolveWorktreeCwdResult,
  UseWorktreeRequest,
  UseWorktreeResult,
} from "./worktrees";

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
  /** Current task cwd; a durable worktree selection overrides transcript provenance. */
  project: string | null;
  app: string;
  topic: string;
  generatedTopic: string;
  ownerTitle: string | null;
  /** Latest generated recap. Null until one exists; it is retained verbatim while refreshing. */
  statusSummary: string | null;
  /** A newer message, child, or working change is not reflected in `statusSummary` yet. */
  statusSummaryPending: boolean;
  priority: number | null;
  state: ThreadState;
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
  children: Array<{ id: string; source: string; lastMessageAt: string | null; runId: string; status: AgentRun["status"] }>;
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

/** Inputs of one harness-details observation; the daemon runs it and returns the snapshot. */
export interface HarnessDetailsRequest {
  harnesses?: AgentRunHarness[];
  inspect?: Array<{ harness: AgentRunHarness; model: string; effort: AgentRunEffort | null }>;
  includeBaselineCandidates?: boolean;
}

export type HarnessDetailsResponse = unknown;

export interface GatewayApi {
  health(): Promise<DaemonHealth>;
  ready(): Promise<DaemonReady>;
  sessionState(): Promise<SessionStateRow[]>;
  markDone(ids: readonly string[]): Promise<MarkThreadsDoneResult>;
  renameThread(id: string, title: string): Promise<void>;
  poll(options?: { reconcile?: Array<{ id: string; lastMessageAt: string }> }): Promise<{ ok: true; queuedIds: string[] }>;
  listSchedules(): Promise<ScheduleDefinition[]>;
  createSchedule(input: ScheduleCreateInput): Promise<ScheduleDefinition>;
  updateSchedule(id: string, input: ScheduleCreateInput): Promise<ScheduleDefinition>;
  deleteSchedule(id: string): Promise<{ ok: true }>;
  runSchedule(id: string): Promise<ScheduleRun>;
  /** Shared, surface-independent delegated-run presentation derived from durable rows. */
  agentState(parentThreadId?: string): Promise<ParentAgentStateView>;
  listAgentRuns(parentThreadId?: string): Promise<AgentRun[]>;
  agentRun(id: string): Promise<AgentRun>;
  delegateAgent(input: AgentRunCreateInput): Promise<AgentRun>;
  cancelAgentRun(id: string): Promise<AgentRun>;
  retryAgentRun(id: string): Promise<AgentRun>;
  resumeAgentRun(id: string, task: string): Promise<AgentRun>;
  waitAgentRun(id: string, timeoutSeconds: number): Promise<AgentRun>;
  queryDatabase(request: DatabaseQueryRequest): Promise<DatabaseQueryResponse>;
  /** One ephemeral harness observation, run by the daemon that owns probe processes. */
  harnessDetails(request: HarnessDetailsRequest): Promise<HarnessDetailsResponse>;
  useWorktree(request: UseWorktreeRequest): Promise<UseWorktreeResult>;
  resolveWorktreeCwd(request: ResolveWorktreeCwdRequest): Promise<ResolveWorktreeCwdResult>;
  /** Connection callbacks bracket each live SSE stream, including replacement reconnects. */
  subscribe(
    listener: (event: GatewayEvent) => void,
    onConnected?: () => void,
    onDisconnected?: () => void,
  ): () => void;
  close(): void;
}

export type { GatewayEvent } from "./events";
