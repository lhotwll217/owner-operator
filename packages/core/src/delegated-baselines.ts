/** The owner-approved model and reasoning effort a delegated run falls back to when its call pins
 * none — one baseline per harness, in `delegated_baselines.json` under the Owner Operator home.
 *
 * Three durable records stay separate on purpose: the harness roster holds the task preferences
 * the owner writes by hand, the `agent_runs` ledger holds what actually ran, and this holds the
 * single fallback identity per harness that the owner explicitly approved.
 *
 * The only write path takes explicit values, so a discovered baseline candidate has no route into
 * this file that does not pass through the owner approving those exact values.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { AgentRunHarness, isAgentRunEffort, type AgentRunEffort } from "./agent-runs";
import { ensureOwnerOperatorWorkspace, ownerOperatorPaths } from "./harness.mjs";

export interface DelegatedBaseline {
  /** The harness's own model identifier, kept verbatim: Claude's ids are opaque and normalizing
   * one would produce a model the harness does not know. */
  model: string;
  /** null when the harness exposes no reasoning-effort control, as Claude Code does not. */
  effort: AgentRunEffort | null;
  /** null on a hand-written entry that carries no approval time. */
  approvedAt: string | null;
}

export type DelegatedBaselines = Partial<Record<AgentRunHarness, DelegatedBaseline>>;

/** What an owner approves. `effort` omitted and `effort: null` both mean "no effort intent". */
export interface DelegatedBaselineApproval {
  model: string;
  effort?: AgentRunEffort | null;
}

const HARNESSES: readonly AgentRunHarness[] = Object.values(AgentRunHarness);

export function loadDelegatedBaselines(ooHome?: string): DelegatedBaselines {
  const raw = readRecord(ownerOperatorPaths(ooHome).delegatedBaselines);
  const baselines: DelegatedBaselines = {};
  for (const harness of HARNESSES) {
    const baseline = normalizeBaseline(raw[harness]);
    if (baseline) baselines[harness] = baseline;
  }
  return baselines;
}

export function loadDelegatedBaseline(
  harness: AgentRunHarness,
  ooHome?: string,
): DelegatedBaseline | null {
  return loadDelegatedBaselines(ooHome)[harness] ?? null;
}

/** Persist a baseline the owner has approved. Named for the consent it records: there is no
 * separate "save candidate" call, so approval is the only way a value becomes durable. */
export function approveDelegatedBaseline(
  harness: AgentRunHarness,
  approval: DelegatedBaselineApproval,
  ooHome?: string,
): DelegatedBaseline {
  const model = typeof approval.model === "string" ? approval.model : "";
  if (!model.trim()) throw new Error("an approved delegated baseline requires a model");
  const effort = approval.effort ?? null;
  // A harness can report an effort outside the durable run vocabulary. Refuse it rather than
  // storing a value no delegated run could ever apply.
  if (effort !== null && !isAgentRunEffort(effort)) {
    throw new Error(`unknown delegation effort: ${String(effort)}`);
  }
  const baseline: DelegatedBaseline = { model, effort, approvedAt: new Date().toISOString() };
  const paths = ensureOwnerOperatorWorkspace(ooHome);
  const merged = { ...readRecordForUpdate(paths.delegatedBaselines), [harness]: baseline };
  writeJsonAtomic(paths.delegatedBaselines, merged);
  return baseline;
}

function readRecord(path: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

/** A read can fail closed to "no baseline"; a write must not replace unreadable approved state. */
function readRecordForUpdate(path: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`invalid delegated baseline configuration at ${path}`);
  }
  return value as Record<string, unknown>;
}

/** An unreadable entry is dropped, not repaired: with no baseline the caller asks the owner, which
 * is the honest outcome. Repairing it would invent an approval that never happened. */
function normalizeBaseline(value: unknown): DelegatedBaseline | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  const model = typeof entry.model === "string" ? entry.model : "";
  if (!model.trim()) return null;
  if (entry.effort != null && !isAgentRunEffort(entry.effort)) return null;
  return {
    model,
    effort: (entry.effort as AgentRunEffort | undefined) ?? null,
    approvedAt: typeof entry.approvedAt === "string" ? entry.approvedAt : null,
  };
}

function writeJsonAtomic(path: string, value: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
    renameSync(temporary, path);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* no temporary file to remove */ }
    throw error;
  }
}
