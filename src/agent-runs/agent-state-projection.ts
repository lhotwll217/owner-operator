import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { AgentRunHarness, type AgentRun } from "@owner-operator/core";
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

/** Reuse ACPX's retained initialize evidence, not a second capability store. Its pinned 0.13.2
 * file contract is documented in docs/delegated-runs.md. Keep this read synchronous alongside
 * the executor's eligibility check/row creation, and fail closed on absent or mismatched records. */
export function openCodeContinuationError(run: AgentRun): string | null {
  if (run.harness !== AgentRunHarness.OpenCode && run.harness !== AgentRunHarness.OpenCode2) return null;
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
    canRetry: run.canRetry && openCodeContinuationError(byId.get(run.id)!) === null,
  })) };
}
