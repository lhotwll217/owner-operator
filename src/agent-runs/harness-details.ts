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

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { AGENT_RUN_CAPABILITIES, AgentRunHarness } from "@owner-operator/core";
import { agentRunStateDir, createLeasedAcpRuntime } from "./acp-launcher";

/** Wall-clock ceiling for one `codex app-server` observation, including process startup. */
const CODEX_APP_SERVER_TIMEOUT_MS = 20_000;
/** Wall-clock ceiling for one unpinned ACP session used to read the harness's own defaults. */
const BASELINE_CANDIDATE_TIMEOUT_MS = 90_000;
const REASONING_EFFORT_CONFIG_OPTION = "reasoning_effort";

/** Identifies which first-party protocol produced a harness's facts, so a reader can tell an
 * observation apart from an assumption. `null` on a harness that exposes no such surface. */
export const CODEX_DETAILS_SOURCE = "codex-app-server";

export interface HarnessModelDetail {
  id: string;
  displayName: string;
  /** Reasoning levels the harness advertises for this model; `[]` = advertised none. */
  reasoningLevels: string[];
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
export interface HarnessBaselineCandidate {
  model: string | null;
  effort: string | null;
  availableEfforts: string[] | null;
}

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

export interface CodexAppServerPayloads {
  account: unknown;
  rateLimits: unknown;
  models: unknown;
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
    return [{
      id,
      displayName: text(model.displayName) ?? id,
      reasoningLevels: normalizeReasoningLevels(model.supportedReasoningEfforts),
      defaultReasoningLevel: text(model.defaultReasoningEffort),
      isDefault: model.isDefault === true,
    }];
  });
}

function normalizeReasoningLevels(payload: unknown): string[] {
  if (!Array.isArray(payload)) return [];
  return payload.flatMap((entry) => {
    const level = text(record(entry)?.reasoningEffort);
    return level ? [level] : [];
  });
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

/** Ask the harness what it would run on its own: open one ACP session that pins neither model nor
 * effort, then read back what the harness selected. The result is reported as a candidate —
 * saving a baseline is a separate step that requires explicit owner approval.
 *
 * A `oneshot` session closes its child process inside `ensureSession`, and the session record is
 * written to a throwaway directory that is deleted here, so a probe leaves nothing durable. */
export async function discoverAcpBaselineCandidate(
  harness: AgentRunHarness,
): Promise<HarnessBaselineCandidate> {
  const probeKey = `harness-details-${randomUUID()}`;
  const probeStateDir = join(agentRunStateDir(), "probes", probeKey);
  const leased = createLeasedAcpRuntime({ harness, leaseKey: probeKey, stateDir: probeStateDir });
  let childClosed = false;
  try {
    // acpx applies no startup deadline of its own, so a harness that never finishes initializing
    // would hang this read indefinitely.
    const handle = await withDeadline(
      leased.runtime.ensureSession({
        sessionKey: probeKey,
        agent: AGENT_RUN_CAPABILITIES[harness].acpAgent,
        mode: "oneshot",
        cwd: process.cwd(),
      }),
      BASELINE_CANDIDATE_TIMEOUT_MS,
      `${harness} did not finish initializing`,
    );
    childClosed = true;
    const status = await leased.runtime.getStatus?.({ handle });
    const effort = readEffortConfigOption(status?.details?.configOptions);
    return {
      model: status?.models?.currentModelId ?? null,
      effort: effort.currentValue,
      availableEfforts: effort.values,
    };
  } finally {
    // An abandoned initialization may still hold a live wrapper. Keep its lease and state so
    // daemon startup can reap the tree; only a settled probe cleans itself up.
    if (childClosed) {
      leased.release();
      rmSync(probeStateDir, { recursive: true, force: true });
    }
  }
}

function withDeadline<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(message)), ms);
      timer.unref();
    }),
  ]);
}

function readEffortConfigOption(
  payload: unknown,
): { currentValue: string | null; values: string[] | null } {
  if (!Array.isArray(payload)) return { currentValue: null, values: null };
  const option = payload
    .map((entry) => record(entry))
    .find((entry) => entry && text(entry.id) === REASONING_EFFORT_CONFIG_OPTION);
  if (!option) return { currentValue: null, values: null };
  const values = Array.isArray(option.options)
    ? option.options.flatMap((entry) => {
      const choice = record(entry);
      if (!choice) return [];
      // A select advertises either flat options or groups of them.
      if (Array.isArray(choice.options)) return normalizeSelectValues(choice.options);
      const value = text(choice.value);
      return value ? [value] : [];
    })
    : null;
  return { currentValue: text(option.currentValue), values };
}

function normalizeSelectValues(payload: readonly unknown[]): string[] {
  return payload.flatMap((entry) => {
    const value = text(record(entry)?.value);
    return value ? [value] : [];
  });
}

interface JsonRpcResponse {
  id?: unknown;
  result?: unknown;
  error?: { message?: unknown };
}

/** Drive one `codex app-server` process over JSON-RPC on stdio and pull the three read-only
 * surfaces. The request order matters: the app-server only starts refreshing its remote model
 * catalog after the client sends `initialized`, and it emits no notification when the refresh
 * lands, so `model/list` is issued last — the two account round-trips cover that window without a
 * fixed sleep. Asking earlier returns a stale locally cached catalog. */
export function readCodexAppServerPayloads(): Promise<CodexAppServerPayloads> {
  return withCodexAppServer(async (client) => ({
    account: await client.request("account/read"),
    rateLimits: await client.request("account/rateLimits/read"),
    models: await client.request("model/list"),
  }));
}

interface CodexAppServerClient {
  request: (method: string, params?: unknown) => Promise<unknown>;
}

async function withCodexAppServer<T>(
  run: (client: CodexAppServerClient) => Promise<T>,
): Promise<T> {
  const child = spawn("codex", ["app-server"], { stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let nextId = 0;
  let failure: Error | undefined;

  const fail = (error: Error): void => {
    failure ??= error;
    for (const [, entry] of pending) entry.reject(error);
    pending.clear();
  };

  child.on("error", (error) => fail(error));
  child.on("exit", (code) => fail(new Error(`codex app-server exited (code ${code ?? "unknown"})`)));
  child.stderr.resume();

  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    let message: JsonRpcResponse;
    try {
      message = JSON.parse(line) as JsonRpcResponse;
    } catch {
      return; // Notifications and any non-JSON banner text are not responses we await.
    }
    if (typeof message.id !== "number") return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(text(message.error.message) ?? "codex app-server error"));
    else entry.resolve(message.result);
  });

  const send = (payload: Record<string, unknown>): void => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...payload })}\n`);
  };

  const request = (method: string, params: unknown = {}): Promise<unknown> => {
    if (failure) return Promise.reject(failure);
    const id = nextId++;
    return new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      send({ id, method, params });
    });
  };

  try {
    return await withDeadline(
      (async () => {
        await request("initialize", {
          clientInfo: { name: "owner-operator", title: "Owner Operator", version: "0.0.0" },
        });
        send({ method: "initialized", params: {} });
        return await run({ request });
      })(),
      CODEX_APP_SERVER_TIMEOUT_MS,
      "codex app-server timed out",
    );
  } finally {
    lines.close();
    terminate(child);
  }
}

function terminate(child: ChildProcessWithoutNullStreams): void {
  try {
    child.stdin.end();
    child.kill("SIGTERM");
  } catch {
    // Already gone.
  }
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
