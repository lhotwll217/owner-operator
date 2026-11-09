import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  AGENT_RUN_CAPABILITIES,
  AGENT_RUN_RESUMABLE_STATUSES,
  AGENT_RUN_RETRYABLE_STATUSES,
  AgentRunHarness,
  isTerminalAgentRunStatus,
  type AgentRun,
  type ChildIdentity,
} from "@owner-operator/core";
import {
  deriveParentAgentState,
  type DeriveParentAgentStateOptions,
  type ParentAgentStateView,
} from "@owner-operator/core/agent-state";
import { ownerOperatorHome } from "../shared/paths";

type Inherited = Pick<AgentRun, "harness" | "cwd" | "parentThreadId" | "model" | "effort" | "depth" | "timeoutSeconds">;

/** A Retry successor is fully determined by its predecessor: same task, same carried completions. */
export type RetrySuccessor = Inherited & {
  task: string;
  retryOfRunId: string;
  completionRunIds: readonly string[];
  childSessionId: string | null;
  acpxRecordId: string | null;
};

/** A Resume successor always continues a saved child; the caller supplies the new task. */
export type ResumeSuccessor = Inherited & {
  resumeOfRunId: string;
  childSessionId: string;
  acpxRecordId: string;
};

/** `reason` reaches the owner verbatim through `oo runs retry|resume`. */
export interface Refused {
  kind: "refused";
  reason: string;
}

export type RetryVerdict =
  | { kind: "eligible"; successor: RetrySuccessor }
  /** An earlier retry of this run is still pending or running; returning it keeps retry idempotent. */
  | { kind: "in-flight"; successor: AgentRun }
  | Refused;

export type ResumeVerdict = { kind: "eligible"; successor: ResumeSuccessor } | Refused;

export interface Continuations {
  retry(run: AgentRun): RetryVerdict;
  resume(run: AgentRun): ResumeVerdict;
}

/** Retry and Resume eligibility over one snapshot of runs. Verdicts read the saved ACPX record and
 * the run's cwd synchronously, so the executor can check and create the successor row atomically. */
export function continuationsOf(runs: readonly AgentRun[]): Continuations {
  const lineage = lineageOf(runs);
  return {
    retry(run) {
      const retried = lineage.retrySuccessor.get(run.id);
      if (retried && !isTerminalAgentRunStatus(retried.status)) return { kind: "in-flight", successor: retried };
      const identity = recoveredIdentity(run);
      if (typeof identity === "string") return refused(identity);
      const candidate = { ...run, ...identity };
      const reason = retryRefusal(candidate, lineage);
      if (reason) return refused(reason);
      return { kind: "eligible", successor: {
        ...inherited(run),
        task: run.task,
        retryOfRunId: run.id,
        completionRunIds: run.completionRunIds,
        childSessionId: candidate.childSessionId,
        acpxRecordId: candidate.acpxRecordId,
      } };
    },
    resume(run) {
      const identity = recoveredIdentity(run);
      if (typeof identity === "string") return refused(identity);
      const candidate = { ...run, ...identity };
      const reason = resumeRefusal(candidate, lineage);
      if (reason) return refused(reason);
      return { kind: "eligible", successor: {
        ...inherited(run),
        resumeOfRunId: run.id,
        childSessionId: candidate.childSessionId!,
        acpxRecordId: candidate.acpxRecordId!,
      } };
    },
  };
}

/** The view the Gateway and the Pi parent session read; the only writer of canRetry and canResume. */
export function deriveParentAgentStateWithEnvironment(
  runs: readonly AgentRun[],
  options: Omit<DeriveParentAgentStateOptions, "continuation"> = {},
): ParentAgentStateView {
  const continuations = continuationsOf(runs);
  return deriveParentAgentState(runs, {
    ...options,
    continuation: (run) => ({
      canRetry: continuations.retry(run).kind === "eligible",
      canResume: continuations.resume(run).kind === "eligible",
    }),
  });
}

export interface Lineage {
  retrySuccessor: ReadonlyMap<string, AgentRun>;
  resumeSuccessor: ReadonlyMap<string, AgentRun>;
  /** The newest run of each child session, in newest-first order. */
  latestByChild: ReadonlyMap<string, AgentRun>;
  /** Pending or running runs by child session. */
  activeByChild: ReadonlyMap<string, AgentRun>;
}

/** Indexes a newest-first snapshot, as `listAgentRuns` returns it. */
export function lineageOf(runs: readonly AgentRun[]): Lineage {
  return {
    retrySuccessor: firstBy(runs, (run) => run.retryOfRunId),
    resumeSuccessor: firstBy(runs, (run) => run.resumeOfRunId),
    latestByChild: firstBy(runs, (run) => run.childSessionId),
    activeByChild: firstBy(runs, (run) => isTerminalAgentRunStatus(run.status) ? null : run.childSessionId),
  };
}

/** The first refusal in the order the owner sees it; `run` already carries any recovered identity. */
function retryRefusal(run: AgentRun, lineage: Lineage): string | null {
  if (!AGENT_RUN_RETRYABLE_STATUSES.includes(run.status)) {
    return `agent run ${run.id} is not retryable from status ${run.status}`;
  }
  if (run.childSessionId && !AGENT_RUN_CAPABILITIES[run.harness]?.loadSession) return cannotLoad(run);
  const retried = lineage.retrySuccessor.get(run.id);
  if (retried) return `agent run ${run.id} has already been retried by ${retried.id}`;
  const resumed = lineage.resumeSuccessor.get(run.id);
  if (resumed) return `agent run ${run.id} has already been resumed by ${resumed.id}`;
  return childBusy(run, lineage) ?? (run.childSessionId ? openCodeContinuationError(run) : null);
}

function resumeRefusal(run: AgentRun, lineage: Lineage): string | null {
  if (!AGENT_RUN_RESUMABLE_STATUSES.includes(run.status)) return `agent run ${run.id} cannot be resumed while ${run.status}`;
  if (!AGENT_RUN_CAPABILITIES[run.harness]?.loadSession) return cannotLoad(run);
  if (!run.childSessionId) return `agent run ${run.id} has no child session identity to resume`;
  if (!run.acpxRecordId) return `agent run ${run.id} has no acpx session-record identity to resume`;
  const resumed = lineage.resumeSuccessor.get(run.id);
  if (resumed) return `agent run ${run.id} has already been resumed by ${resumed.id}`;
  const retried = lineage.retrySuccessor.get(run.id);
  if (retried) return `agent run ${run.id} has already been retried by ${retried.id}`;
  return childBusy(run, lineage) ?? resumeCwdError(run.cwd) ?? openCodeContinuationError(run);
}

function firstBy(runs: readonly AgentRun[], key: (run: AgentRun) => string | null): Map<string, AgentRun> {
  const index = new Map<string, AgentRun>();
  for (const run of runs) {
    const value = key(run);
    if (value !== null && !index.has(value)) index.set(value, run);
  }
  return index;
}

const refused = (reason: string): Refused => ({ kind: "refused", reason });

const inherited = (run: AgentRun): Inherited => ({
  harness: run.harness,
  cwd: run.cwd,
  parentThreadId: run.parentThreadId,
  model: run.model,
  effort: run.effort,
  depth: run.depth,
  timeoutSeconds: run.timeoutSeconds,
});

const cannotLoad = (run: AgentRun): string => `harness ${run.harness} does not support loading an existing session`;

function childBusy(run: AgentRun, lineage: Lineage): string | null {
  const active = run.childSessionId ? lineage.activeByChild.get(run.childSessionId) : undefined;
  return active ? `child session ${run.childSessionId} already has active run ${active.id}` : null;
}

const sessionRecordPath = (recordId: string): string =>
  join(ownerOperatorHome(), "agent-runs", "sessions", `${encodeURIComponent(recordId)}.json`);

/** An unsuccessful startup may have saved an ACP record before the run row received its identity.
 * Returns the identity to continue with, or the refusal when a saved record cannot be trusted. */
function recoveredIdentity(run: AgentRun): ChildIdentity | string {
  if (run.childSessionId) return {};
  const recordId = run.acpxRecordId ?? run.id;
  if (!existsSync(sessionRecordPath(recordId))) {
    return run.acpxRecordId ? `saved ACP session record ${recordId} is missing; no fresh session was started` : {};
  }
  try {
    const record = JSON.parse(readFileSync(sessionRecordPath(recordId), "utf8"));
    const childSessionId = record.agent_session_id ?? record.acp_session_id;
    if (record.schema !== "acpx.session.v1" || record.acpx_record_id !== recordId
      || record.cwd !== run.cwd || typeof record.acp_session_id !== "string"
      || !record.acp_session_id || typeof childSessionId !== "string" || !childSessionId) {
      throw new Error("record identity or workspace does not match the run");
    }
    return { childSessionId, acpxRecordId: recordId };
  } catch (error) {
    return `saved ACP session record ${recordId} cannot be recovered; no fresh session was started: ${String(error)}`;
  }
}

function resumeCwdError(cwd: string): string | null {
  try {
    const stat = statSync(cwd, { throwIfNoEntry: false });
    if (!stat) return `resume working directory no longer exists: ${cwd}`;
    if (!stat.isDirectory()) return `resume working directory is not a directory: ${cwd}`;
    return null;
  } catch {
    return `resume working directory is unavailable: ${cwd}`;
  }
}

/** Reuse ACPX's retained initialize evidence, not a second capability store. Its pinned 0.21.0
 * file contract is documented in docs/delegated-runs.md. Fails closed on absent or mismatched records. */
function openCodeContinuationError(run: AgentRun): string | null {
  if (run.harness !== AgentRunHarness.OpenCode) return null;
  const unavailable = `${run.harness} session continuation capability is unavailable for ${run.id}`;
  if (!run.acpxRecordId) return unavailable;
  try {
    const record = JSON.parse(readFileSync(sessionRecordPath(run.acpxRecordId), "utf8"));
    if (record?.schema !== "acpx.session.v1" || record.acpx_record_id !== run.acpxRecordId
      || (record.agent_session_id ?? record.acp_session_id) !== run.childSessionId || record.cwd !== run.cwd) {
      return unavailable;
    }
    const capabilities = record.agent_capabilities;
    if (capabilities == null) {
      return `Cannot determine whether this saved session can be continued: ${run.harness} ${run.childSessionId}`;
    }
    // ACPX prefers session/resume when advertised; loadSession=false alone does not forbid it.
    const resume = capabilities?.sessionCapabilities?.resume;
    if (capabilities?.loadSession === true || (resume && typeof resume === "object" && !Array.isArray(resume))) {
      return null;
    }
    return `${run.harness} did not advertise session/load or session/resume for ${run.childSessionId}`;
  } catch {
    return unavailable;
  }
}
