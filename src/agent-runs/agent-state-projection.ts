import { statSync } from "node:fs";
import type { AgentRun } from "@owner-operator/core";
import {
  deriveParentAgentState,
  type DeriveParentAgentStateOptions,
  type ParentAgentStateView,
} from "@owner-operator/core/agent-state";

/** Runtime-only workspace validation shared by continuation enforcement and projections. */
export function continuationCwdError(cwd: string): string | null {
  try {
    const stat = statSync(cwd, { throwIfNoEntry: false });
    if (!stat) return `continuation working directory no longer exists: ${cwd}`;
    if (!stat.isDirectory()) return `continuation working directory is not a directory: ${cwd}`;
    return null;
  } catch {
    return `continuation working directory is unavailable: ${cwd}`;
  }
}

/** Node projection adapter: pure core owns lifecycle eligibility; this layer supplies the
 * filesystem fact core deliberately cannot observe. */
export function deriveParentAgentStateWithEnvironment(
  runs: readonly AgentRun[],
  options: Omit<DeriveParentAgentStateOptions, "isContinuationEnvironmentEligible"> = {},
): ParentAgentStateView {
  return deriveParentAgentState(runs, {
    ...options,
    isContinuationEnvironmentEligible: (run) => continuationCwdError(run.cwd) === null,
  });
}
