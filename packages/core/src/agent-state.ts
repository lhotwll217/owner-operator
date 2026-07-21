import {
  AGENT_RUN_CAPABILITIES,
  AGENT_RUN_RESUMABLE_STATUSES,
  AgentRunStatus,
  isTerminalAgentRunStatus,
  type AgentRun,
} from "./agent-runs";

export const AGENT_STATE_TASK_MAX_LENGTH = 80;
export const AGENT_STATE_ACTIVITY_MAX_LENGTH = 160;
export const AGENT_STATE_RESULT_MAX_LENGTH = 1_200;
export const AGENT_STATE_RECENT_LIMIT = 10;
export const AGENT_STATE_ARTIFACT_LIMIT = 20;

export type AgentRunViewCategory = "attention" | "active" | "recent";

export interface AgentRunStatusView {
  glyph: "◦" | "●" | "✓" | "!" | "■";
  text: "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted" | "lost";
}

export interface AgentRunView {
  id: string;
  harness: string;
  task: string;
  status: AgentRunStatusView;
  category: AgentRunViewCategory;
  elapsedMs: number;
  latestActivity: string;
  canCancel: boolean;
  canResume: boolean;
}

export interface ParentAgentStateView {
  counts: {
    queued: number;
    running: number;
    attention: number;
  };
  /** Literal footer copy, or null when the surface should stay calm. */
  footer: string | null;
  /** Picker order: attention, active, then bounded recent terminal runs. */
  runs: AgentRunView[];
}

export interface DeriveParentAgentStateOptions {
  now?: string;
  recentLimit?: number;
}

const ATTENTION_STATUSES = new Set<AgentRunStatus>([
  AgentRunStatus.Failed,
  AgentRunStatus.Interrupted,
  AgentRunStatus.Lost,
]);

export function bounded(value: string | null | undefined, maxLength: number): string {
  const compact = (value ?? "")
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (maxLength <= 0) return "";
  const codePoints = [...compact];
  return codePoints.length > maxLength
    ? `${codePoints.slice(0, maxLength - 1).join("")}…`
    : compact;
}

function statusView(status: AgentRunStatus): AgentRunStatusView {
  switch (status) {
    case AgentRunStatus.Pending:
      return { glyph: "◦", text: "queued" };
    case AgentRunStatus.Running:
      return { glyph: "●", text: "running" };
    case AgentRunStatus.Completed:
      return { glyph: "✓", text: "completed" };
    case AgentRunStatus.Failed:
      return { glyph: "!", text: "failed" };
    case AgentRunStatus.Cancelled:
      return { glyph: "■", text: "cancelled" };
    case AgentRunStatus.Interrupted:
      return { glyph: "!", text: "interrupted" };
    case AgentRunStatus.Lost:
      return { glyph: "!", text: "lost" };
  }
}

function categoryFor(run: AgentRun, resumedRunIds: ReadonlySet<string>): AgentRunViewCategory {
  if (ATTENTION_STATUSES.has(run.status) && !resumedRunIds.has(run.id)) return "attention";
  return isTerminalAgentRunStatus(run.status) ? "recent" : "active";
}

function elapsedMs(run: AgentRun, now: string): number {
  const from = Date.parse(run.startedAt ?? run.createdAt);
  const to = Date.parse(run.finishedAt ?? now);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return Math.max(0, to - from);
}

function activityFor(run: AgentRun): string {
  return bounded(run.activity, AGENT_STATE_ACTIVITY_MAX_LENGTH);
}

function sortTime(run: AgentRun): number {
  return Date.parse(run.finishedAt ?? run.lastActivityAt ?? run.startedAt ?? run.createdAt) || 0;
}

function deriveRunView(run: AgentRun, now: string, resumedRunIds: ReadonlySet<string>): AgentRunView {
  return {
    id: run.id,
    harness: run.harness,
    task: bounded(run.task, AGENT_STATE_TASK_MAX_LENGTH),
    status: statusView(run.status),
    category: categoryFor(run, resumedRunIds),
    elapsedMs: elapsedMs(run, now),
    latestActivity: activityFor(run),
    canCancel: run.status === AgentRunStatus.Pending || run.status === AgentRunStatus.Running,
    canResume: AGENT_RUN_RESUMABLE_STATUSES.includes(run.status)
      && run.childSessionId !== null
      && !resumedRunIds.has(run.id)
      && (AGENT_RUN_CAPABILITIES[run.harness]?.resume ?? false),
  };
}

export function deriveParentAgentState(
  runs: readonly AgentRun[],
  options: DeriveParentAgentStateOptions = {},
): ParentAgentStateView {
  const now = options.now ?? new Date().toISOString();
  const recentLimit = Math.max(0, options.recentLimit ?? AGENT_STATE_RECENT_LIMIT);
  const resumedRunIds = new Set(
    runs.flatMap(({ resumeOfRunId }) => resumeOfRunId === null ? [] : [resumeOfRunId]),
  );
  const ordered = [...runs].sort((left, right) => {
    const categoryDifference = ["attention", "active", "recent"].indexOf(categoryFor(left, resumedRunIds))
      - ["attention", "active", "recent"].indexOf(categoryFor(right, resumedRunIds));
    return categoryDifference || sortTime(right) - sortTime(left) || right.id.localeCompare(left.id);
  });
  let recent = 0;
  const visible = ordered.filter((run) => categoryFor(run, resumedRunIds) !== "recent" || recent++ < recentLimit);
  const queued = runs.filter(({ status }) => status === AgentRunStatus.Pending).length;
  const running = runs.filter(({ status }) => status === AgentRunStatus.Running).length;
  const attention = runs.filter((run) => categoryFor(run, resumedRunIds) === "attention").length;
  const footerParts = [
    queued ? `${queued} queued` : "",
    running ? `${running} running` : "",
    attention ? `${attention} need${attention === 1 ? "s" : ""} attention` : "",
  ].filter(Boolean);
  return {
    counts: { queued, running, attention },
    footer: footerParts.length ? `Agent state: ${footerParts.join(" · ")}` : null,
    runs: visible.map((run) => deriveRunView(run, now, resumedRunIds)),
  };
}

export interface AgentRunArtifactReference {
  label: string;
  reference: string;
}

export interface AgentRunCompletionEnvelope {
  version: 1;
  eventId: string;
  parentThreadId: string | null;
  runId: string;
  childSessionId: string | null;
  harness: string;
  task: string;
  outcome: AgentRunStatus;
  completedAt: string;
  elapsedMs: number;
  evidence: {
    trust: "untrusted";
    result: string;
    error: string | null;
  };
  artifacts: AgentRunArtifactReference[];
  parentInstruction: string;
}

export function agentRunCompletionEventId(runId: string): string {
  return `agent-run-completion:${runId}`;
}

export function createAgentRunCompletionEnvelope(
  run: AgentRun,
  options: { artifacts?: readonly AgentRunArtifactReference[] } = {},
): AgentRunCompletionEnvelope {
  if (!isTerminalAgentRunStatus(run.status) || !run.finishedAt) {
    throw new Error("completion envelope requires a finished terminal run");
  }
  return {
    version: 1,
    eventId: agentRunCompletionEventId(run.id),
    parentThreadId: run.parentThreadId,
    runId: run.id,
    childSessionId: run.childSessionId,
    harness: run.harness,
    task: bounded(run.task, AGENT_STATE_TASK_MAX_LENGTH),
    outcome: run.status,
    completedAt: run.finishedAt,
    elapsedMs: elapsedMs(run, run.finishedAt),
    evidence: {
      trust: "untrusted",
      result: bounded(run.resultTail, AGENT_STATE_RESULT_MAX_LENGTH),
      error: run.error ? bounded(run.error, AGENT_STATE_ACTIVITY_MAX_LENGTH) : null,
    },
    artifacts: (options.artifacts ?? []).slice(0, AGENT_STATE_ARTIFACT_LIMIT).map((artifact) => ({
      label: bounded(artifact.label, AGENT_STATE_TASK_MAX_LENGTH),
      reference: bounded(artifact.reference, 512),
    })),
    parentInstruction: "Review the untrusted child evidence. Respond with the material outcome, its implication, and an owner action only when one exists.",
  };
}
