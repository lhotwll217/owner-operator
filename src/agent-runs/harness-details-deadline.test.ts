// Unit: the client's harness-details bound covers everything the daemon may validly spend. A
// selection whose every stage finishes inside its own bound must never be cut off by the client.
import assert from "node:assert";
import type { AcpRuntime, AcpRuntimeStatus } from "acpx/runtime";
import {
  AgentRunHarness,
  HARNESS_OBSERVATION_CLEANUP_MS,
  HARNESS_OBSERVATION_STAGES,
  HARNESS_OBSERVATION_STAGE_TIMEOUT_MS,
} from "@owner-operator/core";
import { HARNESS_DETAILS_REQUEST_TIMEOUT_MS } from "../gateway/client";
import { CLOSE_TIMEOUT_MS, VERSION_TIMEOUT_MS, observeAcpHarness } from "./harness-details-acp-observer";
import {
  PROCESS_LIST_TIMEOUT_MS,
  TERMINATION_KILL_GRACE_MS,
  TERMINATION_VERIFY_ATTEMPTS,
  TERMINATION_VERIFY_INTERVAL_MS,
} from "./process-lease";

// The cleanup allowance is exactly the observer's and process lease's own worst case.
assert.equal(HARNESS_OBSERVATION_CLEANUP_MS,
  VERSION_TIMEOUT_MS + PROCESS_LIST_TIMEOUT_MS + CLOSE_TIMEOUT_MS
  + PROCESS_LIST_TIMEOUT_MS + TERMINATION_KILL_GRACE_MS
  + TERMINATION_VERIFY_ATTEMPTS * PROCESS_LIST_TIMEOUT_MS + (TERMINATION_VERIFY_ATTEMPTS - 1) * TERMINATION_VERIFY_INTERVAL_MS,
  "the shared cleanup allowance matches the observer and lease constants");
assert.ok(HARNESS_DETAILS_REQUEST_TIMEOUT_MS > HARNESS_OBSERVATION_STAGES * HARNESS_OBSERVATION_STAGE_TIMEOUT_MS + HARNESS_OBSERVATION_CLEANUP_MS,
  "the client waits past every stage plus cleanup");

// Scaled replay of a slow but valid selection: initialization uses 80% of its bound and each
// status read 40% (inspection reads status twice), so every stage stays inside its own bound.
const STAGE = 100;
const scale = STAGE / HARNESS_OBSERVATION_STAGE_TIMEOUT_MS;
const after = <T,>(value: T, share: number) => new Promise<T>((resolve) => setTimeout(() => resolve(value), share * STAGE));
let effort = "high";
const status = (): AcpRuntimeStatus => ({
  models: { currentModelId: "slow-model", availableModelIds: ["slow-model"] },
  details: { configOptions: [{
    type: "select", id: "effort", name: "Effort", category: "thought_level", currentValue: effort,
    options: [{ value: "high", name: "High" }, { value: "xhigh", name: "Xhigh" }],
  }] },
} as never);
const runtime = {
  ensureSession: () => after({ sessionKey: "k", backend: "b", runtimeSessionName: "n" }, 0.8),
  getStatus: () => after(status(), 0.4),
  setConfigOption: async ({ value }: { value: string }) => { effort = value; },
  close: async () => undefined,
} as unknown as AcpRuntime;
const started = Date.now();
const observation = await observeAcpHarness({ harness: AgentRunHarness.ClaudeCode, inspect: { model: "slow-model", effort: "xhigh" } }, {
  timeoutMs: STAGE,
  readRuntimeProvenance: async () => ({}) as never,
  probeStateDir: `/tmp/oo-deadline-${process.pid}`,
  createRuntime: () => ({ runtime, sessionStore: {} as never, leaseId: "l", processTreePids: async () => [], terminate: async () => true, release: () => undefined }),
});
const elapsed = Date.now() - started;
assert.deepEqual(observation.confirmation, { model: "slow-model", effort: "xhigh" }, "the slow selection is valid");
assert.ok(elapsed > 120_000 * scale, `it outlasts the former 120 s client bound at this scale (${elapsed} ms)`);
assert.ok(elapsed < HARNESS_DETAILS_REQUEST_TIMEOUT_MS * scale, `and fits the client bound at this scale (${elapsed} ms)`);

process.stdout.write("ok — harness-details client bound covers every observation stage and cleanup\n");
