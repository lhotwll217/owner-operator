/** Delegated-run vocabulary shared by clients, state, and the daemon executor (issue #69).
 *
 * A delegated run is one execution of a child agent launched through the ledger and owned
 * by the daemon. Two-entity model: the child agent's session identity (a thread, once its
 * transcript is observed) is separate from the run record tracked here. Lifecycle and the
 * per-harness capability records follow the decision record on issue #69.
 */

export enum AgentRunHarness {
  ClaudeCode = "claude-code",
  Codex = "codex",
}

export enum AgentRunStatus {
  Pending = "pending",
  Running = "running",
  Completed = "completed",
  Failed = "failed",
  Cancelled = "cancelled",
  Interrupted = "interrupted",
  Lost = "lost",
}

/** Terminal states are monotonic: once reached, a run row never changes status again,
 * except that `interrupted` and `lost` may be resumed — which creates a NEW run under
 * the same child identity, never a status downgrade on the old row. */
export const AGENT_RUN_TERMINAL_STATUSES: readonly AgentRunStatus[] = [
  AgentRunStatus.Completed,
  AgentRunStatus.Failed,
  AgentRunStatus.Cancelled,
  AgentRunStatus.Interrupted,
  AgentRunStatus.Lost,
];

export function isTerminalAgentRunStatus(status: AgentRunStatus): boolean {
  return AGENT_RUN_TERMINAL_STATUSES.includes(status);
}

/** Statuses a resume may start from. Resumption requires a persisted child session id. */
export const AGENT_RUN_RESUMABLE_STATUSES: readonly AgentRunStatus[] = [
  AgentRunStatus.Interrupted,
  AgentRunStatus.Lost,
  AgentRunStatus.Failed,
];

/** What Owner Operator can do with a child of a given harness. The floor is never zero:
 * every harness gets a durable run row, an activity source, and inspect/cancel/result. */
export interface AgentRunCapabilityRecord {
  harness: AgentRunHarness;
  /** Agent name in the acpx launch registry. */
  acpAgent: string;
  /** Where explicit activity comes from; never inferred from transcript growth. */
  activitySource: "acp-events";
  steerMidRun: boolean;
  asksToParent: boolean;
  resume: boolean;
}

export const AGENT_RUN_CAPABILITIES: Readonly<Record<AgentRunHarness, AgentRunCapabilityRecord>> = {
  [AgentRunHarness.ClaudeCode]: {
    harness: AgentRunHarness.ClaudeCode,
    acpAgent: "claude",
    activitySource: "acp-events",
    steerMidRun: false,
    asksToParent: false,
    resume: true,
  },
  [AgentRunHarness.Codex]: {
    harness: AgentRunHarness.Codex,
    acpAgent: "codex",
    activitySource: "acp-events",
    steerMidRun: false,
    asksToParent: false,
    resume: true,
  },
};

/** Only the Operator delegates through the ledger (depth 1). Children needing helpers use
 * their harness's native subagents, which never touch the ledger. */
export const AGENT_RUN_MAX_DEPTH = 1;

export const DEFAULT_AGENT_RUN_TIMEOUT_SECONDS = 3_600;
export const MAX_AGENT_RUN_TIMEOUT_SECONDS = 86_400;

export interface AgentRunCreateInput {
  harness: AgentRunHarness;
  /** The task prompt handed to the child agent. */
  task: string;
  /** Absolute working directory the child runs in. */
  cwd: string;
  /** Owner Operator thread id of the delegating session, when known. */
  parentThreadId?: string | null;
  /** Model the child should run, when the owner pins one; null lets the harness pick. */
  model?: string | null;
  timeoutSeconds?: number;
}

export interface AgentRun {
  id: string;
  harness: AgentRunHarness;
  task: string;
  cwd: string;
  parentThreadId: string | null;
  model: string | null;
  depth: number;
  status: AgentRunStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** Latest explicit activity line published by the child's runtime. */
  activity: string | null;
  lastActivityAt: string | null;
  /** The child harness's own session id — the resume identity and the monitor join key. */
  childSessionId: string | null;
  /** acpx session-record id, the second identity level persisted for reconciliation. */
  acpxRecordId: string | null;
  /** Bounded tail of the child's final report. */
  resultTail: string | null;
  /** Terminal failure/interruption/loss explanation. */
  error: string | null;
  /** Set when this run resumes an earlier run's child identity. */
  resumeOfRunId: string | null;
  timeoutSeconds: number;
}

/** Runtime request passed from the executor to the injected launcher seam. */
export interface AgentRunLaunchRequest {
  run: AgentRun;
  /** Child session to resume, when this run continues an earlier one. */
  resumeSessionId: string | null;
  signal: AbortSignal;
  /** Explicit-activity channel: the launcher reports progress and identity as soon as known. */
  onActivity(update: {
    activity?: string;
    childSessionId?: string;
    acpxRecordId?: string;
  }): void;
}

/** Protocol-level outcome. A turn result finalizes a run — never process exit alone. */
export interface AgentRunLaunchResult {
  status: AgentRunStatus.Completed | AgentRunStatus.Cancelled | AgentRunStatus.Failed;
  resultText: string;
  error: string | null;
  childSessionId?: string;
  acpxRecordId?: string;
}

/** The terminal statuses a finalized run may land in — pending/running are excluded because a
 * run is never *finished* into them. */
export type AgentRunFinalStatus =
  | AgentRunStatus.Completed
  | AgentRunStatus.Failed
  | AgentRunStatus.Cancelled
  | AgentRunStatus.Interrupted;

/** How a run is finalized in the ledger. Shared by the executor, the State seam, and the DB. */
export interface AgentRunOutcome {
  status: AgentRunFinalStatus;
  resultTail: string | null;
  error: string | null;
  childSessionId?: string;
  acpxRecordId?: string;
}
