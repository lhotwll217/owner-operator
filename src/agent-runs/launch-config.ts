/** What model and reasoning effort a delegated run actually launches with, and how the baseline it
 * falls back to is proposed to the owner.
 *
 * Owner Operator holds no product literals here. A run either carries the values its caller pinned
 * or the values the owner approved for that harness; with neither, there is no honest answer and
 * the launch asks instead of inventing one. */

import {
  isAgentRunEffort,
  loadDelegatedBaseline,
  type AgentRunEffort,
  type AgentRunHarness,
  type DelegatedBaseline,
} from "@owner-operator/core";
import { discoverAcpBaselineCandidate, type HarnessBaselineCandidate } from "./harness-details";

export interface AgentRunLaunchPins {
  model?: string | null;
  effort?: AgentRunEffort | null;
}

/** The identity a run launches with. Both fields are resolved before the durable row is written,
 * so the ledger always states what was actually requested of the harness. */
export interface ResolvedAgentRunLaunch {
  model: string;
  effort: AgentRunEffort | null;
}

/** A pinned value wins. An omitted one is filled from the approved baseline and applied
 * explicitly, so the harness's ambient configuration never decides a delegated run's identity. */
export function resolveAgentRunLaunch(
  harness: AgentRunHarness,
  pins: AgentRunLaunchPins = {},
  ooHome?: string,
): ResolvedAgentRunLaunch {
  if (pins.model === null) {
    throw new Error(`delegated run for ${harness} requires a model; explicit null does not use the approved baseline`);
  }
  const baseline = loadDelegatedBaseline(harness, ooHome);
  const model = pins.model === undefined ? baseline?.model ?? null : pins.model;
  if (!model) {
    throw new Error(
      `no approved delegated baseline for ${harness}: pin a model on this call, or discover a ` +
      "candidate and have the owner approve it with manage_delegated_baseline",
    );
  }
  const effort = Object.hasOwn(pins, "effort") ? pins.effort ?? null : baseline?.effort ?? null;
  return { model, effort };
}

/** What the owner is being asked to decide: what is approved now, what the harness would choose
 * for itself today, and whether those differ. */
export interface DelegatedBaselineProposal {
  harness: AgentRunHarness;
  approved: DelegatedBaseline | null;
  candidate: HarnessBaselineCandidate | null;
  /** Why discovery produced no candidate. The owner is asked to choose; nothing is substituted. */
  error: string | null;
  /** True only when a candidate was observed and it differs from what is approved. */
  differs: boolean;
}

export interface ProposeDelegatedBaselineOptions {
  discover?: (harness: AgentRunHarness) => Promise<HarnessBaselineCandidate>;
  ooHome?: string;
}

/** Ask the harness what it would run on its own and hold that against the approved baseline. This
 * is also the refresh path: it reads and compares, and never writes, so a harness that changed its
 * own default cannot change Owner Operator's until the owner approves the new values. */
export async function proposeDelegatedBaseline(
  harness: AgentRunHarness,
  options: ProposeDelegatedBaselineOptions = {},
): Promise<DelegatedBaselineProposal> {
  const approved = loadDelegatedBaseline(harness, options.ooHome);
  try {
    const candidate = await (options.discover ?? discoverAcpBaselineCandidate)(harness);
    if (!candidate.model?.trim()) {
      throw new Error(`${harness} baseline discovery returned no usable model`);
    }
    if (candidate.effort !== null && !isAgentRunEffort(candidate.effort)) {
      throw new Error(`${harness} baseline discovery returned unsupported effort: ${candidate.effort}`);
    }
    return {
      harness,
      approved,
      candidate,
      error: null,
      differs: candidate.model !== (approved?.model ?? null)
        || candidate.effort !== (approved?.effort ?? null),
    };
  } catch (error) {
    return {
      harness,
      approved,
      candidate: null,
      error: error instanceof Error ? error.message : String(error),
      differs: false,
    };
  }
}
