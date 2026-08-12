/** Read-only, ephemeral observation of what a delegation harness currently offers: its model
 * catalog, the reasoning levels each model supports, the subscription plan, and how much of each
 * subscription allowance window is spent.
 *
 * Boundaries this module holds:
 * - Nothing here is persisted or cached. Every call re-observes and the result is a snapshot.
 * - `null` means "unknown — no surface exposed this"; `[]` means "observed, and there are none".
 * - One harness failing cannot erase another: failures land in that harness's own `errors`.
 * - No task selection or ranking happens here. Callers decide what to do with the facts.
 */

import { AGENT_RUN_CAPABILITIES, AgentRunHarness, isAgentRunEffort } from "@owner-operator/core";
import {
  discoverAcpBaselineCandidate,
  type BaselineProbeDeps,
  type HarnessBaselineCandidate,
} from "./harness-details-baseline-probe";
import {
  readCodexAppServerPayloads,
  type CodexAppServerOptions,
  type CodexAppServerPayloads,
} from "./harness-details-codex-client";

export { discoverAcpBaselineCandidate, readCodexAppServerPayloads };
export type { BaselineProbeDeps, CodexAppServerOptions, CodexAppServerPayloads };

/** Identifies which first-party protocol produced a harness's facts, so a reader can tell an
 * observation apart from an assumption. `null` on a harness that exposes no such surface. */
export const CODEX_DETAILS_SOURCE = "codex-app-server";

export interface HarnessModelDetail {
  id: string;
  displayName: string;
  /** Reasoning levels the harness advertises for this model. `null` = the catalog entry carried
   * no readable levels (unknown); `[]` = it advertised the levels and there are none. */
  reasoningLevels: string[] | null;
  /** Advertised values the public delegation contract cannot apply. Never selectable. */
  unsupportedReasoningLevels: string[];
  /** The level the harness itself picks for this model when the caller pins nothing. */
  defaultReasoningLevel: string | null;
  isDefault: boolean;
}

/** One subscription allowance window. `usedPercent` is share of the subscription allowance
 * consumed — never a token count and never a list-price figure. */
export interface HarnessAllowanceWindow {
  id: string;
  label: string | null;
  usedPercent: number;
  /** Epoch seconds when the window rolls over. */
  resetsAt: number | null;
  windowMinutes: number | null;
}

export interface HarnessAccountDetail {
  plan: string | null;
}

/** What the harness selects for itself when Owner Operator pins nothing. Reported, never saved:
 * persisting an approved baseline is a separate, owner-consented step. */
export type { HarnessBaselineCandidate };

export interface HarnessDetails {
  harness: AgentRunHarness;
  observedAt: string;
  source: string | null;
  account: HarnessAccountDetail | null;
  models: HarnessModelDetail[] | null;
  allowanceWindows: HarnessAllowanceWindow[] | null;
  baselineCandidate: HarnessBaselineCandidate | null;
  notes: string[];
  errors: string[];
}

export interface HarnessDetailsDeps {
  readCodexPayloads?: () => Promise<CodexAppServerPayloads>;
  discoverBaselineCandidate?: (harness: AgentRunHarness) => Promise<HarnessBaselineCandidate>;
  now?: () => Date;
}

export interface ReadHarnessDetailsOptions {
  harnesses?: readonly AgentRunHarness[];
  /** Off by default: discovery starts a real harness session, which costs seconds. */
  includeBaselineCandidates?: boolean;
  deps?: HarnessDetailsDeps;
}

const ALL_HARNESSES: readonly AgentRunHarness[] = [AgentRunHarness.Codex, AgentRunHarness.ClaudeCode];

/** Observe each requested harness independently and concurrently. A harness that throws still
 * returns a row carrying its own error, so one broken harness cannot erase another's facts. */
export async function readHarnessDetails(
  options: ReadHarnessDetailsOptions = {},
): Promise<HarnessDetails[]> {
  const requested = options.harnesses?.length ? [...new Set(options.harnesses)] : ALL_HARNESSES;
  const known = requested.filter((harness) => AGENT_RUN_CAPABILITIES[harness]);
  const observedAt = (options.deps?.now?.() ?? new Date()).toISOString();
  return await Promise.all(known.map((harness) =>
    readOneHarness(harness, observedAt, options)
  ));
}

async function readOneHarness(
  harness: AgentRunHarness,
  observedAt: string,
  options: ReadHarnessDetailsOptions,
): Promise<HarnessDetails> {
  const details = harness === AgentRunHarness.Codex
    ? await readCodexDetails(observedAt, options.deps)
    : claudeCodeDetails(observedAt);
  if (!options.includeBaselineCandidates) return details;

  const discover = options.deps?.discoverBaselineCandidate ?? discoverAcpBaselineCandidate;
  try {
    return { ...details, baselineCandidate: await discover(harness) };
  } catch (error) {
    // A failed candidate probe must not discard facts already read from the first-party surface.
    return { ...details, errors: [...details.errors, `baseline candidate: ${messageOf(error)}`] };
  }
}

async function readCodexDetails(
  observedAt: string,
  deps: HarnessDetailsDeps | undefined,
): Promise<HarnessDetails> {
  try {
    const payloads = await (deps?.readCodexPayloads ?? readCodexAppServerPayloads)();
    return normalizeCodexHarnessDetails(payloads, observedAt);
  } catch (error) {
    return {
      ...emptyDetails(AgentRunHarness.Codex, observedAt),
      source: CODEX_DETAILS_SOURCE,
      errors: [messageOf(error)],
    };
  }
}

/** Claude Code exposes no first-party protocol for its catalog, plan, or allowance windows, so
 * those facts stay explicitly unknown rather than being inferred from docs or pricing pages. */
function claudeCodeDetails(observedAt: string): HarnessDetails {
  return {
    ...emptyDetails(AgentRunHarness.ClaudeCode, observedAt),
    notes: [
      "Claude Code exposes no first-party model catalog, plan, or allowance surface; those facts are unknown, not empty.",
    ],
  };
}

function emptyDetails(harness: AgentRunHarness, observedAt: string): HarnessDetails {
  return {
    harness,
    observedAt,
    source: null,
    account: null,
    models: null,
    allowanceWindows: null,
    baselineCandidate: null,
    notes: [],
    errors: [],
  };
}

/** Map raw `codex app-server` results onto the normalized shape. Each fact degrades on its own:
 * an unreadable catalog leaves `models` null without touching plan or allowance windows. */
export function normalizeCodexHarnessDetails(
  payloads: CodexAppServerPayloads,
  observedAt: string,
): HarnessDetails {
  return {
    harness: AgentRunHarness.Codex,
    observedAt,
    source: CODEX_DETAILS_SOURCE,
    account: normalizeCodexAccount(payloads.account),
    models: normalizeCodexModels(payloads.models),
    allowanceWindows: normalizeCodexAllowanceWindows(payloads.rateLimits),
    baselineCandidate: null,
    notes: [],
    errors: [],
  };
}

function normalizeCodexAccount(payload: unknown): HarnessAccountDetail | null {
  const account = record(record(payload)?.account);
  if (!account) return null;
  return { plan: text(account.planType) };
}

function normalizeCodexModels(payload: unknown): HarnessModelDetail[] | null {
  const data = record(payload)?.data;
  if (!Array.isArray(data)) return null;
  return data.flatMap((entry) => {
    const model = record(entry);
    const id = model && text(model.id);
    // A catalog entry without an id cannot be selected later, so it is not a fact worth carrying.
    if (!model || !id || model.hidden === true) return [];
    const advertisedLevels = normalizeReasoningLevels(model.supportedReasoningEfforts);
    return [{
      id,
      displayName: text(model.displayName) ?? id,
      reasoningLevels: advertisedLevels?.filter(isAgentRunEffort) ?? advertisedLevels,
      unsupportedReasoningLevels: advertisedLevels?.filter((level) => !isAgentRunEffort(level)) ?? [],
      defaultReasoningLevel: isAgentRunEffort(text(model.defaultReasoningEffort))
        ? text(model.defaultReasoningEffort)
        : null,
      isDefault: model.isDefault === true,
    }];
  });
}

/** Only an advertised empty list means "this model has no reasoning levels". An absent or
 * unreadable field is unknown: collapsing it to `[]` would let a caller conclude the harness
 * offers no levels when in fact none were observed. */
function normalizeReasoningLevels(payload: unknown): string[] | null {
  if (!Array.isArray(payload)) return null;
  if (!payload.length) return [];
  const levels = payload.flatMap((entry) => {
    const level = text(record(entry)?.reasoningEffort);
    return level ? [level] : [];
  });
  return levels.length ? levels : null;
}

/** Codex reports allowance either as one snapshot or keyed by limit id, and each entry carries up
 * to two windows. Prefer the keyed view when populated — it is the superset — and emit one row per
 * window so a short and a long window are never averaged together. */
function normalizeCodexAllowanceWindows(payload: unknown): HarnessAllowanceWindow[] | null {
  const root = record(payload);
  if (!root) return null;
  const byLimitId = record(root.rateLimitsByLimitId);
  const snapshots = byLimitId && Object.keys(byLimitId).length
    ? Object.entries(byLimitId).map(([key, value]) => ({ fallbackId: key, snapshot: value }))
    : [{ fallbackId: "codex", snapshot: root.rateLimits }];

  const windows = snapshots.flatMap(({ fallbackId, snapshot }) => {
    const limit = record(snapshot);
    if (!limit) return [];
    const limitId = text(limit.limitId) ?? fallbackId;
    const label = text(limit.limitName);
    return (["primary", "secondary"] as const).flatMap((slot) => {
      const window = normalizeCodexWindow(limit[slot], `${limitId}:${slot}`, label);
      return window ? [window] : [];
    });
  });
  // Code-unit order, not locale collation: the output must be identical on every machine.
  return windows.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

function normalizeCodexWindow(
  payload: unknown,
  id: string,
  label: string | null,
): HarnessAllowanceWindow | null {
  const window = record(payload);
  const usedPercent = window && numeric(window.usedPercent);
  if (!window || usedPercent === null) return null;
  return {
    id,
    label,
    usedPercent,
    resetsAt: numeric(window.resetsAt),
    windowMinutes: numeric(window.windowDurationMins),
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function numeric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
