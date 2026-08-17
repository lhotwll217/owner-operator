import { statSync } from "node:fs";
import type { AgentRun } from "@owner-operator/core";
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

/** Node projection adapter: pure core owns lifecycle eligibility; this layer supplies the
 * filesystem fact core deliberately cannot observe. */
export function deriveParentAgentStateWithEnvironment(
  runs: readonly AgentRun[],
  options: Omit<DeriveParentAgentStateOptions, "isResumeEnvironmentEligible"> = {},
): ParentAgentStateView {
  return deriveParentAgentState(runs, {
    ...options,
    isResumeEnvironmentEligible: (run) => resumeCwdError(run.cwd) === null,
  });
}
