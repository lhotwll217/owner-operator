/** Launch-authoritative harness snapshot.
 *
 * User preferences, ACP capability facts, and provider account/allowance facts are deliberately
 * separate. Every source is observed independently; `null` means unknown and `[]` means the
 * source advertised none. Capability and account results are never persisted or cached; the
 * workspace path layer resolves which owner preference file to read without moving it.
 */

import { readFileSync } from "node:fs";
import {
  AGENT_RUN_CAPABILITIES,
  AgentRunHarness,
  ownerOperatorPaths,
  type AgentRunEffort,
} from "@owner-operator/core";
import { ownerOperatorHome } from "../shared/paths";
import {
  baselineCandidateFromObservation,
  discoverAcpBaselineCandidate,
  type BaselineProbeDeps,
  type HarnessBaselineCandidate,
} from "./harness-details-baseline-probe";
import {
  observeAcpHarness,
  readAcpRegistryProvenance,
  type AcpRegistryProvenance,
  type HarnessCapabilityObservation,
} from "./harness-details-acp-observer";
import {
  readCodexAppServerPayloads,
  type CodexAppServerOptions,
  type CodexAppServerPayloads,
} from "./harness-details-codex-client";
import {
  readCursorCliPayloads,
  type CursorCliOptions,
  type CursorCliPayloads,
} from "./harness-details-cursor-client";

export {
  discoverAcpBaselineCandidate,
  observeAcpHarness,
  readAcpRegistryProvenance,
  readCodexAppServerPayloads,
  readCursorCliPayloads,
};
export type {
  BaselineProbeDeps,
  CodexAppServerOptions,
  CodexAppServerPayloads,
  CursorCliOptions,
  CursorCliPayloads,
  HarnessBaselineCandidate,
  HarnessCapabilityObservation,
};

export const CODEX_ACCOUNT_SOURCE = "codex-app-server";
export const CURSOR_ACCOUNT_SOURCE = "cursor-agent-cli";

export interface HarnessAllowanceWindow {
  id: string;
  label: string | null;
  usedPercent: number;
  /** Epoch seconds when the allowance window rolls over. */
  resetsAt: number | null;
  windowMinutes: number | null;
}

export interface HarnessAccountDetail {
  plan: string | null;
}

export interface HarnessPreferencesObservation {
  path: string;
  content: string | null;
  error: string | null;
}

export interface HarnessAccountObservation {
  harness: AgentRunHarness;
  observedAt: string;
  source: typeof CODEX_ACCOUNT_SOURCE | typeof CURSOR_ACCOUNT_SOURCE | null;
  account: HarnessAccountDetail | null;
  authenticated: boolean | null;
  allowanceWindows: HarnessAllowanceWindow[] | null;
  notes: string[];
  errors: string[];
}

export interface HarnessCapabilitySnapshot extends HarnessCapabilityObservation {
  baselineCandidate: HarnessBaselineCandidate | null;
}

export interface HarnessUnknown {
  harness?: AgentRunHarness;
  fact: string;
  reason: string;
}

export interface HarnessDetailsSnapshot {
  observedAt: string;
  ephemeral: true;
  preferences: HarnessPreferencesObservation;
  capabilities: {
    registry: AcpRegistryProvenance;
    harnesses: HarnessCapabilitySnapshot[];
  };
  account: HarnessAccountObservation[];
  unknowns: HarnessUnknown[];
}

export interface HarnessDetailsDeps {
  observeCapability?: (
    harness: AgentRunHarness,
    observedAt: string,
    inspect?: { model: string; effort: AgentRunEffort | null },
  ) => Promise<HarnessCapabilityObservation>;
  readCodexPayloads?: () => Promise<CodexAppServerPayloads>;
  readCursorPayloads?: () => Promise<CursorCliPayloads>;
  readPreferences?: () => HarnessPreferencesObservation | Promise<HarnessPreferencesObservation>;
  readRegistryProvenance?: () => AcpRegistryProvenance;
  now?: () => Date;
}

export interface HarnessInspectionRequest {
  harness: AgentRunHarness;
  model: string;
  effort: AgentRunEffort | null;
}

export interface ReadHarnessDetailsOptions {
  harnesses?: readonly AgentRunHarness[];
  /** Verify at most one exact model/nullable-effort candidate per harness through the same
   * apply-and-confirm path used by delegated launch. */
  inspect?: readonly HarnessInspectionRequest[];
  /** Off by default. When requested, the unpinned ACP observation is also projected as a
   * consent-neutral baseline candidate; it is never saved. */
  includeBaselineCandidates?: boolean;
  deps?: HarnessDetailsDeps;
}

const ALL_HARNESSES: readonly AgentRunHarness[] = [
  AgentRunHarness.Codex,
  AgentRunHarness.ClaudeCode,
  AgentRunHarness.Cursor,
];

/** Observe preferences, every requested ACP session, and account sources concurrently. A source
 * failure stays in its own namespace and cannot erase successful sibling observations. */
export async function readHarnessDetails(
  options: ReadHarnessDetailsOptions = {},
): Promise<HarnessDetailsSnapshot> {
  assertUniqueHarnessInspections(options.inspect ?? []);
  const inspections = new Map((options.inspect ?? []).map((request) => [request.harness, request]));
  const ordinary = options.harnesses?.length
    ? [...new Set(options.harnesses)]
    : inspections.size
      ? []
      : ALL_HARNESSES;
  const requested = [...new Set([...ordinary, ...inspections.keys()])];
  const harnesses = requested.filter((harness) => AGENT_RUN_CAPABILITIES[harness]);
  const observedAt = (options.deps?.now?.() ?? new Date()).toISOString();
  const observe = options.deps?.observeCapability
    ?? ((harness: AgentRunHarness, _observedAt: string, inspect?: { model: string; effort: AgentRunEffort | null }) => observeAcpHarness({
      harness,
      ...(inspect ? { inspect: { model: inspect.model, effort: inspect.effort } } : {}),
    }, {
      now: () => new Date(observedAt),
    }));

  const [preferences, capabilityRows, account] = await Promise.all([
    Promise.resolve((options.deps?.readPreferences ?? readUserHarnessPreferences)()),
    Promise.all(harnesses.map(async (harness) => {
      try {
        const inspection = inspections.get(harness);
        return await observe(harness, observedAt, inspection
          ? { model: inspection.model, effort: inspection.effort }
          : undefined);
      } catch (error) {
        return failedCapability(harness, observedAt, messageOf(error), inspections.get(harness));
      }
    })),
    Promise.all(harnesses.map((harness) => readHarnessAccount(harness, observedAt, options.deps))),
  ]);
  const capabilities = capabilityRows.map((observation): HarnessCapabilitySnapshot => {
    if (!options.includeBaselineCandidates || observation.requestedInspection) {
      return { ...observation, baselineCandidate: null };
    }
    try {
      return { ...observation, baselineCandidate: baselineCandidateFromObservation(observation) };
    } catch (error) {
      return {
        ...observation,
        baselineCandidate: null,
        error: observation.error ?? `baseline candidate: ${messageOf(error)}`,
      };
    }
  });
  const snapshot: HarnessDetailsSnapshot = {
    observedAt,
    ephemeral: true,
    preferences,
    capabilities: {
      registry: (options.deps?.readRegistryProvenance ?? readAcpRegistryProvenance)(),
      harnesses: capabilities,
    },
    account,
    unknowns: [],
  };
  snapshot.unknowns = unknownsIn(snapshot);
  return snapshot;
}

function failedCapability(
  harness: AgentRunHarness,
  observedAt: string,
  error: string,
  inspection?: HarnessInspectionRequest,
): HarnessCapabilityObservation {
  return {
    harness,
    acpxAgent: AGENT_RUN_CAPABILITIES[harness].acpAgent,
    observedAt,
    runtime: null,
    requestedInspection: inspection
      ? { model: inspection.model, effort: inspection.effort }
      : null,
    session: null,
    confirmation: null,
    error,
  };
}

/** Reject ambiguous public requests before any preference, account, or ACP source is touched. */
function assertUniqueHarnessInspections(
  inspections: readonly HarnessInspectionRequest[],
): void {
  const seen = new Set<AgentRunHarness>();
  for (const inspection of inspections) {
    if (seen.has(inspection.harness)) {
      throw new Error(`get_harness_details received duplicate inspection entries for harness ${inspection.harness}`);
    }
    seen.add(inspection.harness);
  }
}

export function readUserHarnessPreferences(): HarnessPreferencesObservation {
  const path = ownerOperatorPaths(ownerOperatorHome()).userHarnessPreferences;
  try {
    return {
      path,
      content: readFileSync(path, "utf8"),
      error: null,
    };
  } catch (error) {
    return {
      path,
      content: null,
      error: messageOf(error),
    };
  }
}

async function readHarnessAccount(
  harness: AgentRunHarness,
  observedAt: string,
  deps: HarnessDetailsDeps | undefined,
): Promise<HarnessAccountObservation> {
  if (harness === AgentRunHarness.Codex) {
    try {
      return normalizeCodexAccountObservation(
        await (deps?.readCodexPayloads ?? readCodexAppServerPayloads)(),
        observedAt,
      );
    } catch (error) {
      return {
        ...emptyAccount(harness, observedAt),
        source: CODEX_ACCOUNT_SOURCE,
        errors: [messageOf(error)],
      };
    }
  }
  if (harness === AgentRunHarness.Cursor) {
    try {
      return normalizeCursorAccountObservation(
        await (deps?.readCursorPayloads ?? readCursorCliPayloads)(),
        observedAt,
      );
    } catch (error) {
      return {
        ...emptyAccount(harness, observedAt),
        source: CURSOR_ACCOUNT_SOURCE,
        errors: [messageOf(error)],
      };
    }
  }
  return {
    ...emptyAccount(harness, observedAt),
    notes: ["Claude Code exposes no first-party plan or allowance surface; those facts are unknown."],
  };
}

export function normalizeCodexAccountObservation(
  payloads: CodexAppServerPayloads,
  observedAt: string,
): HarnessAccountObservation {
  return {
    ...emptyAccount(AgentRunHarness.Codex, observedAt),
    source: CODEX_ACCOUNT_SOURCE,
    account: normalizeCodexAccount(payloads.account),
    allowanceWindows: normalizeCodexAllowanceWindows(payloads.rateLimits),
  };
}

export function normalizeCursorAccountObservation(
  payloads: CursorCliPayloads,
  observedAt: string,
): HarnessAccountObservation {
  const status = record(payloads.status);
  const authenticated = typeof status?.isAuthenticated === "boolean"
    ? status.isAuthenticated
    : null;
  const errors = [...payloads.errors];
  if (authenticated === false) errors.push("cursor-agent is not authenticated; run `cursor-agent login`");
  return {
    ...emptyAccount(AgentRunHarness.Cursor, observedAt),
    source: CURSOR_ACCOUNT_SOURCE,
    account: normalizeCursorAccount(payloads.about),
    authenticated,
    notes: ["Cursor exposes no allowance-window surface; allowance facts are unknown."],
    errors,
  };
}

function emptyAccount(harness: AgentRunHarness, observedAt: string): HarnessAccountObservation {
  return {
    harness,
    observedAt,
    source: null,
    account: null,
    authenticated: null,
    allowanceWindows: null,
    notes: [],
    errors: [],
  };
}

function normalizeCursorAccount(payload: unknown): HarnessAccountDetail | null {
  const about = record(payload);
  if (!about) return null;
  return { plan: text(about.subscriptionTier) };
}

function normalizeCodexAccount(payload: unknown): HarnessAccountDetail | null {
  const account = record(record(payload)?.account);
  if (!account) return null;
  return { plan: text(account.planType) };
}

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

function unknownsIn(snapshot: HarnessDetailsSnapshot): HarnessUnknown[] {
  const unknowns: HarnessUnknown[] = [];
  if (snapshot.preferences.content === null) {
    unknowns.push({ fact: "preferences.content", reason: snapshot.preferences.error ?? "no preference file observed" });
  }
  for (const row of snapshot.capabilities.harnesses) {
    if (row.runtime === null) unknowns.push({ harness: row.harness, fact: "capabilities.runtime", reason: row.error ?? "not observed" });
    if (row.session === null) {
      unknowns.push({ harness: row.harness, fact: "capabilities.session", reason: row.error ?? "not observed" });
      continue;
    }
    if (row.session.models === null) {
      unknowns.push({ harness: row.harness, fact: "capabilities.session.models", reason: "not advertised" });
    } else if (row.session.models.currentModelId === undefined) {
      unknowns.push({ harness: row.harness, fact: "capabilities.session.models.currentModelId", reason: "not advertised" });
    }
    if (row.session.configOptions === null) unknowns.push({ harness: row.harness, fact: "capabilities.session.configOptions", reason: "not advertised" });
    if (row.session.usage === null) unknowns.push({ harness: row.harness, fact: "capabilities.session.usage", reason: "not advertised" });
  }
  for (const row of snapshot.account) {
    if (row.account === null || row.account.plan === null) {
      unknowns.push({ harness: row.harness, fact: "account.plan", reason: row.errors[0] ?? "no provider surface" });
    }
    if (row.authenticated === null) {
      unknowns.push({ harness: row.harness, fact: "account.authenticated", reason: row.errors[0] ?? "no provider surface" });
    }
    if (row.allowanceWindows === null) unknowns.push({ harness: row.harness, fact: "account.allowanceWindows", reason: row.errors[0] ?? "no provider surface" });
  }
  return unknowns;
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
