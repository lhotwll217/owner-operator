/** The owner-approved model and reasoning effort a delegated run falls back to when its call pins
 * none — one atomically replaced file per harness under `delegated-baselines/` in the Owner
 * Operator home. Independent files make concurrent approvals independent across processes.
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
import { dirname, join } from "node:path";
import { AgentRunHarness, isAgentRunEffort, type AgentRunEffort } from "./agent-runs";
import { ensureOwnerOperatorWorkspace, ownerOperatorPaths } from "./harness.mjs";

export interface DelegatedBaseline {
  /** The harness's own model identifier, kept verbatim: Claude's ids are opaque and normalizing
   * one would produce a model the harness does not know. */
  model: string;
  /** null when the harness exposes no reasoning-effort control, as Claude Code does not. */
  effort: AgentRunEffort | null;
  approvedAt: string;
}

export type DelegatedBaselines = Partial<Record<AgentRunHarness, DelegatedBaseline>>;

/** What an owner approves. Effort is an explicit decision; null means "no effort intent". */
export interface DelegatedBaselineApproval {
  model: string;
  effort: AgentRunEffort | null;
}

const HARNESSES: readonly AgentRunHarness[] = Object.values(AgentRunHarness);

export function loadDelegatedBaselines(ooHome?: string): DelegatedBaselines {
  const baselines: DelegatedBaselines = {};
  for (const harness of HARNESSES) {
    const baseline = normalizeBaseline(readValue(baselinePath(harness, ooHome)));
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
  if (!Object.hasOwn(approval, "effort")) {
    throw new Error("an approved delegated baseline requires an explicit effort (null is allowed)");
  }
  const effort = approval.effort;
  // A harness can report an effort outside the durable run vocabulary. Refuse it rather than
  // storing a value no delegated run could ever apply.
  if (effort !== null && !isAgentRunEffort(effort)) {
    throw new Error(`unknown delegation effort: ${String(effort)}`);
  }
  const baseline: DelegatedBaseline = { model, effort, approvedAt: new Date().toISOString() };
  const paths = ensureOwnerOperatorWorkspace(ooHome);
  writeJsonAtomic(join(paths.delegatedBaselines, `${harness}.json`), baseline);
  return baseline;
}

function baselinePath(harness: AgentRunHarness, ooHome?: string): string {
  return join(ownerOperatorPaths(ooHome).delegatedBaselines, `${harness}.json`);
}

function readValue(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** An unreadable entry is dropped, not repaired: with no baseline the caller asks the owner, which
 * is the honest outcome. Repairing it would invent an approval that never happened. */
function normalizeBaseline(value: unknown): DelegatedBaseline | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  if (!Object.hasOwn(entry, "model") || !Object.hasOwn(entry, "effort")
    || !Object.hasOwn(entry, "approvedAt")) return null;
  const model = typeof entry.model === "string" ? entry.model : "";
  if (!model.trim()) return null;
  if (entry.effort !== null && !isAgentRunEffort(entry.effort)) return null;
  if (typeof entry.approvedAt !== "string" || !entry.approvedAt) return null;
  return {
    model,
    effort: entry.effort as AgentRunEffort | null,
    approvedAt: entry.approvedAt,
  };
}

function writeJsonAtomic(path: string, value: DelegatedBaseline): void {
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
