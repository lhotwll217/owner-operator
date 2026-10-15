import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { AgentRunHarness, agentRunResumeError, isTerminalAgentRunStatus,
  type AgentRun, type ChildIdentity } from "@owner-operator/core";
import { ownerOperatorHome } from "../shared/paths";
import {
  deriveParentAgentState,
  type DeriveParentAgentStateOptions,
  type ParentAgentStateView,
} from "@owner-operator/core/agent-state";

/** Runtime-only workspace validation shared by resume enforcement and projections. */
export function resumeCwdError(cwd: string): string | null {
  try {
    const stat = statSync(cwd, { throwIfNoEntry: false });
    if (!stat) return `resume working directory no longer exists: ${cwd}`;
    if (!stat.isDirectory()) return `resume working directory is not a directory: ${cwd}`;
    return null;
  } catch {
    return `resume working directory is unavailable: ${cwd}`;
  }
}

/** An unsuccessful startup may have saved an ACP record before the run row received its identity. */
export function recoverSavedSessionIdentity(run: AgentRun): ChildIdentity | null {
  if (run.childSessionId) return null;
  const recordId = run.acpxRecordId ?? run.id;
  const path = join(ownerOperatorHome(), "agent-runs", "sessions", `${encodeURIComponent(recordId)}.json`);
  if (!existsSync(path)) {
    if (run.acpxRecordId) throw new Error(`saved ACP session record ${recordId} is missing; no fresh session was started`);
    return null;
  }
  try {
    const record = JSON.parse(readFileSync(path, "utf8"));
    const childSessionId = record.agent_session_id ?? record.acp_session_id;
    if (record.schema !== "acpx.session.v1" || record.acpx_record_id !== recordId
      || record.cwd !== run.cwd || typeof record.acp_session_id !== "string"
      || !record.acp_session_id || typeof childSessionId !== "string" || !childSessionId) {
      throw new Error("record identity or workspace does not match the run");
    }
    return { childSessionId, acpxRecordId: recordId };
  } catch (error) {
    throw new Error(`saved ACP session record ${recordId} cannot be recovered; no fresh session was started: ${String(error)}`);
  }
}

function canRecoverStartupRetry(run: AgentRun, runs: readonly AgentRun[]): boolean {
  try {
    const identity = recoverSavedSessionIdentity(run);
    return !identity || (openCodeContinuationError({ ...run, ...identity }) === null
      && !runs.some((other) => !isTerminalAgentRunStatus(other.status)
        && other.childSessionId === identity.childSessionId));
  } catch {
    return false;
  }
}

function canRecoverResume(run: AgentRun, runs: readonly AgentRun[]): boolean {
  try {
    const identity = recoverSavedSessionIdentity(run);
    if (!identity || resumeCwdError(run.cwd) || openCodeContinuationError({ ...run, ...identity })) return false;
    const existingResumeRunId = runs.find((other) => other.resumeOfRunId === run.id)?.id ?? null;
    const existingRetryRunId = runs.find((other) => other.retryOfRunId === run.id)?.id ?? null;
    const activeRunId = runs.find((other) => !isTerminalAgentRunStatus(other.status)
      && other.childSessionId === identity.childSessionId)?.id ?? null;
    return agentRunResumeError({ ...run, ...identity }, { existingRetryRunId, existingResumeRunId, activeRunId }) === null;
  } catch {
    return false;
  }
}

/** Reuse ACPX's retained initialize evidence, not a second capability store. Its pinned 0.13.2
 * file contract is documented in docs/delegated-runs.md. Keep this read synchronous alongside
 * the executor's eligibility check/row creation, and fail closed on absent or mismatched records. */
export function openCodeContinuationError(run: AgentRun): string | null {
  if (run.harness !== AgentRunHarness.OpenCode) return null;
  const unavailable = `${run.harness} session continuation capability is unavailable for ${run.id}`;
  if (!run.acpxRecordId) return unavailable;
  try {
    const record = JSON.parse(readFileSync(join(ownerOperatorHome(), "agent-runs", "sessions",
      `${encodeURIComponent(run.acpxRecordId)}.json`), "utf8"));
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

/** Node projection adapter: pure core owns lifecycle eligibility; this layer supplies the
 * filesystem fact core deliberately cannot observe. */
export function deriveParentAgentStateWithEnvironment(
  runs: readonly AgentRun[],
  options: Omit<DeriveParentAgentStateOptions, "isResumeEnvironmentEligible"> = {},
): ParentAgentStateView {
  const view = deriveParentAgentState(runs, {
    ...options,
    isResumeEnvironmentEligible: (run) => resumeCwdError(run.cwd) === null && openCodeContinuationError(run) === null,
  });
  const byId = new Map(runs.map((run) => [run.id, run]));
  return { ...view, runs: view.runs.map((run) => ({
    ...run,
    canRetry: run.canRetry && (byId.get(run.id)!.childSessionId
      ? openCodeContinuationError(byId.get(run.id)!) === null
      : canRecoverStartupRetry(byId.get(run.id)!, runs)),
    canResume: run.canResume || (!byId.get(run.id)!.childSessionId && canRecoverResume(byId.get(run.id)!, runs)),
  })) };
}
