import { type AgentRunHarness, isAgentRunEffort } from "@owner-operator/core";
import { advertisedSelectValues, resolveThoughtLevelSelector } from "./acp-session-selection";
import {
  observeAcpHarness,
  type AcpObservationDeps,
  type HarnessCapabilityObservation,
} from "./harness-details-acp-observer";

export interface HarnessBaselineCandidate {
  model: string | null;
  effort: string | null;
  availableEfforts: string[] | null;
}

export type BaselineProbeDeps = AcpObservationDeps;

/** Preserve the existing candidate seam while delegating session ownership to the canonical ACP
 * observer. The result remains a proposal only and is never persisted here. */
export async function discoverAcpBaselineCandidate(
  harness: AgentRunHarness,
  deps: BaselineProbeDeps = {},
): Promise<HarnessBaselineCandidate> {
  return baselineCandidateFromObservation(await observeAcpHarness({ harness }, deps));
}

export function baselineCandidateFromObservation(
  observation: HarnessCapabilityObservation,
): HarnessBaselineCandidate {
  if (observation.error) throw new Error(observation.error);
  const model = observation.session?.models?.currentModelId?.trim() || null;
  if (!model) throw new Error(`${observation.harness} baseline discovery returned no usable model`);
  const options = observation.session?.configOptions;
  if (!options) return { model, effort: null, availableEfforts: null };
  const resolution = resolveThoughtLevelSelector(options);
  if (resolution.kind === "ambiguous") {
    throw new Error(`ACP_CONFIG_OPTIONS_INVALID: ${resolution.detail}`);
  }
  if (resolution.kind === "missing") return { model, effort: null, availableEfforts: null };
  const option = resolution.selector;
  if (!isAgentRunEffort(option.currentValue)) {
    throw new Error(
      `${observation.harness} baseline discovery returned unsupported effort: ${option.currentValue}`,
    );
  }
  return {
    model,
    effort: option.currentValue,
    availableEfforts: advertisedSelectValues(option),
  };
}
