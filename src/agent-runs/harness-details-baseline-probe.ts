import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { AcpRuntimeHandle } from "acpx/runtime";
import { AGENT_RUN_CAPABILITIES, type AgentRunHarness, isAgentRunEffort } from "@owner-operator/core";
import { ownerOperatorHome } from "../shared/paths";
import { agentRunStateDir, createLeasedAcpRuntime, type LeasedAcpRuntime } from "./acp-launcher";

const TIMEOUT_MS = 90_000;
const EFFORT_OPTION = "reasoning_effort";

export interface HarnessBaselineCandidate { model: string | null; effort: string | null; availableEfforts: string[] | null }
export interface BaselineProbeDeps {
  createRuntime?: (params: { harness: AgentRunHarness; leaseKey: string; stateDir: string }) => LeasedAcpRuntime;
  timeoutMs?: number;
}

/** Private ACP probe lifecycle. The facade decides when discovery is appropriate. */
export async function discoverAcpBaselineCandidate(
  harness: AgentRunHarness,
  deps: BaselineProbeDeps = {},
): Promise<HarnessBaselineCandidate> {
  const probeKey = `harness-details-${randomUUID()}`;
  const probeStateDir = join(agentRunStateDir(), "probes", probeKey);
  const leased = (deps.createRuntime ?? createLeasedAcpRuntime)({ harness, leaseKey: probeKey, stateDir: probeStateDir });
  const session = leased.runtime.ensureSession({
    sessionKey: probeKey,
    agent: AGENT_RUN_CAPABILITIES[harness].acpAgent,
    mode: "oneshot",
    cwd: ownerOperatorHome(),
  });
  let opened = false;
  let timedOut = false;
  try {
    const handle = await withDeadline(session, deps.timeoutMs ?? TIMEOUT_MS, `${harness} did not finish initializing`);
    opened = true;
    const status = await leased.runtime.getStatus?.({ handle });
    const effort = readEffort(status?.details?.configOptions);
    const model = status?.models?.currentModelId?.trim() || null;
    if (!model) throw new Error(`${harness} baseline discovery returned no usable model`);
    if (effort.currentValue !== null && !isAgentRunEffort(effort.currentValue)) {
      throw new Error(`${harness} baseline discovery returned unsupported effort: ${effort.currentValue}`);
    }
    return { model, effort: effort.currentValue, availableEfforts: effort.values };
  } catch (error) {
    timedOut = error instanceof Error && error.message.includes("did not finish initializing");
    throw error;
  } finally {
    if (opened || !timedOut) discard(leased, probeStateDir);
    else await discardAbandoned(leased, session, probeStateDir);
  }
}

function discard(leased: LeasedAcpRuntime, stateDir: string): void { leased.release(); rmSync(stateDir, { recursive: true, force: true }); }
async function discardAbandoned(leased: LeasedAcpRuntime, session: Promise<AcpRuntimeHandle>, stateDir: string): Promise<void> {
  void session.catch(() => undefined);
  const terminated = await leased.terminate();
  rmSync(stateDir, { recursive: true, force: true });
  if (terminated) leased.release();
}
function readEffort(payload: unknown): { currentValue: string | null; values: string[] | null } {
  if (!Array.isArray(payload)) return { currentValue: null, values: null };
  const option = payload.map(record).find((entry) => entry && text(entry.id) === EFFORT_OPTION);
  if (!option) return { currentValue: null, values: null };
  const values = Array.isArray(option.options) ? option.options.flatMap((entry) => {
    const choice = record(entry);
    if (!choice) return [];
    if (Array.isArray(choice.options)) return choice.options.flatMap((nested) => {
      const value = text(record(nested)?.value); return value ? [value] : [];
    });
    const value = text(choice.value); return value ? [value] : [];
  }) : null;
  return { currentValue: text(option.currentValue), values };
}
function withDeadline<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([work, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })])
    .finally(() => clearTimeout(timer));
}
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function text(value: unknown): string | null { return typeof value === "string" && value.trim() ? value : null; }
