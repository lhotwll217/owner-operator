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
  Cursor = "cursor",
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

/** Harness-neutral reasoning-effort intent supported by the durable run contract. */
export const AGENT_RUN_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type AgentRunEffort = (typeof AGENT_RUN_EFFORTS)[number];

export function isAgentRunEffort(value: unknown): value is AgentRunEffort {
  return typeof value === "string" && AGENT_RUN_EFFORTS.includes(value as AgentRunEffort);
}

/** Live harness identity evidence. An observed value always contains at least one supported fact;
 * this makes an empty or wholly unsupported status impossible to report as observed. */
export type HarnessIdentityObservation =
  | { observed: false }
  | { observed: true; model: string; effort?: AgentRunEffort }
  | { observed: true; model?: string; effort: AgentRunEffort };

export function harnessIdentityObservation(input: {
  model?: unknown;
  effort?: unknown;
}): HarnessIdentityObservation {
  const model = typeof input.model === "string" && input.model.trim() ? input.model : undefined;
  const effort = isAgentRunEffort(input.effort) ? input.effort : undefined;
  if (model && effort) return { observed: true, model, effort };
  if (model) return { observed: true, model };
  if (effort) return { observed: true, effort };
  return { observed: false };
}

/** Terminal states are monotonic: retry and resume always create a
 * new run under the same child identity, never a status downgrade on the old row. */
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

/** Statuses a retry may start from. Retrying requires a persisted child session id. */
export const AGENT_RUN_RETRYABLE_STATUSES: readonly AgentRunStatus[] = [
  AgentRunStatus.Interrupted,
  AgentRunStatus.Lost,
  AgentRunStatus.Failed,
];

export const AGENT_RUN_RESUME_TASK_ERROR = "resume follow-up task is required";

/** Preserve the owner's task bytes while applying one validation rule at every public boundary. */
export function validateAgentRunResumeTask(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(AGENT_RUN_RESUME_TASK_ERROR);
  }
  return value;
}

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
  loadSession: boolean;
}

export const AGENT_RUN_CAPABILITIES: Readonly<Record<AgentRunHarness, AgentRunCapabilityRecord>> = {
  [AgentRunHarness.ClaudeCode]: {
    harness: AgentRunHarness.ClaudeCode,
    acpAgent: "claude",
    activitySource: "acp-events",
    steerMidRun: false,
    asksToParent: false,
    loadSession: true,
  },
  [AgentRunHarness.Codex]: {
    harness: AgentRunHarness.Codex,
    acpAgent: "codex",
    activitySource: "acp-events",
    steerMidRun: false,
    asksToParent: false,
    loadSession: true,
  },
  // Pinned from a live `cursor-agent acp` initialize response (CLI 2026.07.08): the server
  // advertises loadSession; it advertises no steer or parent-ask surface.
  [AgentRunHarness.Cursor]: {
    harness: AgentRunHarness.Cursor,
    acpAgent: "cursor",
    activitySource: "acp-events",
    steerMidRun: false,
    asksToParent: false,
    loadSession: true,
  },
};

/** Delegation-depth cap: only the Operator delegates through the ledger (depth 1). Why the cap is
 * 1, and how a child gets a helper instead, is documented on the behavior page
 * (docs/delegated-runs.md, Execution). */
export const AGENT_RUN_MAX_DEPTH = 1;

export const DEFAULT_AGENT_RUN_TIMEOUT_SECONDS = 3_600;
export const MAX_AGENT_RUN_TIMEOUT_SECONDS = 86_400;

/** Bounds for a caller's optional blocking wait on a run (delegate_agent's waitSeconds,
 * manage_agent_run's wait, and the gateway wait route). */
export const DEFAULT_AGENT_RUN_WAIT_SECONDS = 60;
export const MAX_AGENT_RUN_WAIT_SECONDS = 3_600;

export interface AgentRunCreateInput {
  harness: AgentRunHarness;
  /** The task the child agent is asked to carry out. */
  task: string;
  /** Absolute working directory the child runs in. */
  cwd: string;
  /** Owner Operator thread id of the delegating session, when known. */
  parentThreadId?: string | null;
  /** Model the child should run, when the owner pins one; null lets the harness pick. */
  model?: string | null;
  /** Reasoning effort requested for the child; omission uses the baseline, explicit null clears it. */
  effort?: AgentRunEffort | null;
  timeoutSeconds?: number;
}

export interface AgentRun {
  id: string;
  harness: AgentRunHarness;
  task: string;
  cwd: string;
  parentThreadId: string | null;
  model: string | null;
  /** Resolved reasoning-effort intent; null means no intent was resolved, never a filler value. */
  effort: AgentRunEffort | null;
  /** True only after the launcher successfully applies effort through an advertised option. */
  effortApplied: boolean;
  /** Canonical identity independently read back from the live harness after configuration. */
  harnessIdentity: HarnessIdentityObservation;
  depth: number;
  status: AgentRunStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** Latest explicit activity line published by the child's runtime. */
  activity: string | null;
  lastActivityAt: string | null;
  /** The child harness's own session id — the persistent-session identity and monitor join key. */
  childSessionId: string | null;
  /** acpx session-record id, the second identity level persisted for reconciliation. */
  acpxRecordId: string | null;
  /** Bounded tail of the child's final report. */
  resultTail: string | null;
  /** Terminal failure/interruption/loss explanation. */
  error: string | null;
  /** Exact unsuccessful run whose task this row retries. */
  retryOfRunId: string | null;
  /** Exact completed run after which this row sends a required new task. */
  resumeOfRunId: string | null;
  timeoutSeconds: number;
}

export interface AgentRunResumeContext {
  existingResumeRunId: string | null;
  activeRunId: string | null;
}

export interface AgentRunRetryContext {
  existingRetryRunId: string | null;
  activeRunId: string | null;
}

/** Pure retry eligibility shared by executor enforcement and presentation derivation. */
export function agentRunRetryError(
  run: AgentRun,
  context: AgentRunRetryContext,
): string | null {
  if (!AGENT_RUN_RETRYABLE_STATUSES.includes(run.status)) {
    return `agent run ${run.id} is not retryable from status ${run.status}`;
  }
  if (!AGENT_RUN_CAPABILITIES[run.harness]?.loadSession) {
    return `harness ${run.harness} does not support loading an existing session`;
  }
  if (!run.childSessionId) return `agent run ${run.id} has no child session identity to retry`;
  if (context.existingRetryRunId) {
    return `agent run ${run.id} has already been retried by ${context.existingRetryRunId}`;
  }
  if (context.activeRunId) {
    return `child session ${run.childSessionId} already has active run ${context.activeRunId}`;
  }
  return null;
}

/** Pure resume eligibility shared by executor enforcement and presentation derivation.
 * Runtime-only facts such as cwd availability remain outside core. */
export function agentRunResumeError(
  run: AgentRun,
  context: AgentRunResumeContext,
): string | null {
  if (run.status !== AgentRunStatus.Completed) {
    return `agent run ${run.id} can only be resumed from completed status, not ${run.status}`;
  }
  if (!AGENT_RUN_CAPABILITIES[run.harness]?.loadSession) {
    return `harness ${run.harness} does not support loading an existing session`;
  }
  if (!run.childSessionId) return `completed agent run ${run.id} has no child session identity to resume`;
  if (!run.acpxRecordId) return `completed agent run ${run.id} has no acpx session-record identity to resume`;
  if (context.existingResumeRunId) {
    return `agent run ${run.id} has already been resumed by ${context.existingResumeRunId}`;
  }
  if (context.activeRunId) {
    return `child session ${run.childSessionId} already has active run ${context.activeRunId}`;
  }
  return null;
}

/** Explicit runtime intent derived from the two semantic run relationships. Referenced rows are
 * immutable; a missing or inconsistent relationship must fail rather than launch fresh. */
export type AgentRunTurnIntent =
  | { kind: "fresh" }
  | { kind: "retry"; childSessionId: string; acpxRecordId?: string }
  | { kind: "resume"; childSessionId: string; acpxRecordId: string };

export function agentRunTurnIntent(
  run: AgentRun,
  retriedRun: AgentRun | undefined,
  resumedRun: AgentRun | undefined,
): AgentRunTurnIntent {
  if (run.retryOfRunId && run.resumeOfRunId) {
    throw new Error(`agent run ${run.id} cannot set both retryOfRunId and resumeOfRunId`);
  }
  if (!run.retryOfRunId && !run.resumeOfRunId) return { kind: "fresh" };
  if (run.retryOfRunId) {
    if (!retriedRun) {
      throw new Error(`agent run ${run.id} references missing retry run ${run.retryOfRunId}`);
    }
    if (retriedRun.id !== run.retryOfRunId) {
      throw new Error(`agent run ${run.id} retry identity mismatch: expected ${run.retryOfRunId}, found ${retriedRun.id}`);
    }
    if (!run.childSessionId || run.childSessionId !== retriedRun.childSessionId) {
      throw new Error(`agent run ${run.id} child identity mismatch with retried run ${retriedRun.id}`);
    }
    if (run.acpxRecordId !== retriedRun.acpxRecordId) {
      throw new Error(`agent run ${run.id} acpx record identity mismatch with retried run ${retriedRun.id}`);
    }
    if (!AGENT_RUN_RETRYABLE_STATUSES.includes(retriedRun.status)) {
      throw new Error(`agent run ${run.id} cannot retry run ${retriedRun.id} from status ${retriedRun.status}`);
    }
    return {
      kind: "retry",
      childSessionId: run.childSessionId,
      ...(run.acpxRecordId ? { acpxRecordId: run.acpxRecordId } : {}),
    };
  }
  if (!resumedRun) {
    throw new Error(`agent run ${run.id} references missing resume run ${run.resumeOfRunId}`);
  }
  if (resumedRun.id !== run.resumeOfRunId) {
    throw new Error(`agent run ${run.id} resume identity mismatch: expected ${run.resumeOfRunId}, found ${resumedRun.id}`);
  }
  if (resumedRun.status !== AgentRunStatus.Completed) {
    throw new Error(`agent run ${run.id} cannot resume run ${resumedRun.id} from status ${resumedRun.status}`);
  }
  if (!run.childSessionId || run.childSessionId !== resumedRun.childSessionId) {
    throw new Error(`agent run ${run.id} child identity mismatch with resumed run ${resumedRun.id}`);
  }
  if (!run.acpxRecordId || run.acpxRecordId !== resumedRun.acpxRecordId) {
    throw new Error(`agent run ${run.id} acpx record identity mismatch with resumed run ${resumedRun.id}`);
  }
  return {
    kind: "resume",
    childSessionId: run.childSessionId,
    acpxRecordId: run.acpxRecordId,
  };
}

/** The two ids a delegated child carries — captured together from the acpx handle and flowed
 * together everywhere: the harness's own persistent-session id and the acpx
 * record id (reconciliation). Fields are omitted, not nulled, until known. */
export interface ChildIdentity {
  childSessionId?: string;
  acpxRecordId?: string;
}

/** An explicit activity update from the child's runtime: a progress line and/or its identity. */
export interface AgentRunActivityUpdate extends ChildIdentity {
  activity?: string;
  /** Runtime acknowledgement that the resolved effort was applied. */
  effortApplied?: boolean;
  harnessIdentity?: HarnessIdentityObservation;
}

/** Runtime request passed from the executor to the injected launcher seam. */
export interface AgentRunLaunchRequest {
  run: AgentRun;
  /** Fresh launch, same-task retry, or exact completed-session resume. */
  turnIntent: AgentRunTurnIntent;
  signal: AbortSignal;
  /** Explicit-activity channel: the launcher reports progress and identity as soon as known. */
  onActivity(update: AgentRunActivityUpdate): void;
}

/** Protocol-level outcome. A turn result finalizes a run — never process exit alone. */
export interface AgentRunLaunchResult extends ChildIdentity {
  status: AgentRunStatus.Completed | AgentRunStatus.Cancelled | AgentRunStatus.Failed;
  resultText: string;
  error: string | null;
}

/** The terminal statuses a finalized run may land in — pending/running are excluded because a
 * run is never *finished* into them. */
export type AgentRunFinalStatus =
  | AgentRunStatus.Completed
  | AgentRunStatus.Failed
  | AgentRunStatus.Cancelled
  | AgentRunStatus.Interrupted;

/** How a run is finalized in the ledger. Shared by the executor, the State seam, and the DB. */
export interface AgentRunOutcome extends ChildIdentity {
  status: AgentRunFinalStatus;
  resultTail: string | null;
  error: string | null;
}
