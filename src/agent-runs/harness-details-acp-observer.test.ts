import assert from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { AgentRunHarness } from "@owner-operator/core";
import type { AcpRuntime, AcpRuntimeEnsureInput, AcpRuntimeStatus } from "acpx/runtime";
import type { LeasedAcpRuntime } from "./acp-launcher";
import {
  observeAcpHarness,
  readAcpRegistryProvenance,
  readAcpRuntimeProvenance,
  type AcpRuntimeProvenance,
} from "./harness-details-acp-observer";

const OBSERVED_AT = "2026-08-25T12:00:00.000Z";
const provenance: AcpRuntimeProvenance = {
  acpxVersion: "0.13.1",
  adapter: {
    packageName: "@agentclientprotocol/codex-acp",
    packageVersion: "1.6.2",
    resolution: "package-lock",
  },
  backend: { name: "@openai/codex", version: "0.148.0", source: "adapter-dependency" },
};
const completeOptions = [{
  type: "select",
  id: "model",
  name: "Model",
  category: "model",
  currentValue: "gpt-ticket-03",
  options: [{ value: "gpt-ticket-03", name: "Ticket 03", description: "fixture model" }],
  "x-owner-operator-fixture": { preserved: true },
}] as unknown as SessionConfigOption[];

interface Lifecycle {
  close: number;
  processTree: number;
  terminate: number;
  release: number;
}

function leasedRuntime(
  ensure: () => Promise<{ sessionKey: string; backend: string; runtimeSessionName: string }>,
  status: () => Promise<AcpRuntimeStatus>,
  lifecycle: Lifecycle,
  terminationConfirmed = true,
  closeWork: () => Promise<void> = async () => undefined,
  hooks: {
    calls?: string[];
    ensureInputs?: AcpRuntimeEnsureInput[];
    setConfigOption?: (key: string, value: string) => void | Promise<void>;
  } = {},
): LeasedAcpRuntime {
  const runtime = {
    ensureSession: (input: AcpRuntimeEnsureInput) => {
      hooks.calls?.push("ensure");
      hooks.ensureInputs?.push(input);
      return ensure();
    },
    getStatus: async () => {
      hooks.calls?.push("status");
      return status();
    },
    setConfigOption: async ({ key, value }: { key: string; value: string }) => {
      hooks.calls?.push(`set:${key}:${value}`);
      await hooks.setConfigOption?.(key, value);
    },
    close: async () => { lifecycle.close += 1; await closeWork(); },
  } as unknown as AcpRuntime;
  return {
    runtime,
    sessionStore: {} as LeasedAcpRuntime["sessionStore"],
    leaseId: "lease",
    processTreePids: async () => { lifecycle.processTree += 1; return [123]; },
    terminate: async (pids) => {
      lifecycle.terminate += 1;
      assert.deepEqual(pids, lifecycle.close ? [123] : undefined);
      return terminationConfirmed;
    },
    release: () => { lifecycle.release += 1; },
  };
}

const temp = mkdtempSync(join(tmpdir(), "oo-acp-observer-"));
try {
  {
    const lifecycle: Lifecycle = { close: 0, processTree: 0, terminate: 0, release: 0 };
    const calls: string[] = [];
    const ensureInputs: AcpRuntimeEnsureInput[] = [];
    const candidate = { model: "claude-fable-5[1m]", effort: "xhigh" as const };
    const initialOptions = [{
      type: "select", id: "effort", name: "Effort", category: "thought_level",
      currentValue: "high", options: [{ value: "high", name: "High" }, { value: "xhigh", name: "Xhigh" }],
    }] as SessionConfigOption[];
    const confirmedOptions = [
      { ...initialOptions[0], currentValue: "xhigh", extensionField: { preserved: true } },
      { type: "boolean", id: "mode", name: "Mode", currentValue: true },
    ] as unknown as SessionConfigOption[];
    const statuses: AcpRuntimeStatus[] = [
      { models: { currentModelId: candidate.model, availableModelIds: [candidate.model] }, details: { configOptions: initialOptions } },
      { models: { currentModelId: candidate.model, availableModelIds: [candidate.model] }, details: { configOptions: initialOptions } },
      { models: { currentModelId: candidate.model, availableModelIds: [candidate.model] }, details: { configOptions: confirmedOptions } },
    ];
    const observation = await observeAcpHarness({
      harness: AgentRunHarness.ClaudeCode,
      inspect: candidate,
    }, {
      readRuntimeProvenance: async () => provenance,
      createRuntime: () => leasedRuntime(
        async () => ({ sessionKey: "probe", backend: "acpx", runtimeSessionName: "probe" }),
        async () => statuses.shift()!,
        lifecycle,
        true,
        async () => undefined,
        { calls, ensureInputs },
      ),
    });
    assert.deepEqual(calls, ["ensure", "status", "status", "set:effort:xhigh", "status"]);
    assert.deepEqual(ensureInputs[0]?.sessionOptions, { model: candidate.model }, "the exact opaque model is established at initialization");
    assert.deepEqual(observation.requestedInspection, candidate);
    assert.deepEqual(observation.confirmation, candidate);
    assert.equal(observation.session?.configOptions, confirmedOptions, "the row exposes complete post-selection configuration");
    assert.equal(observation.error, null);
    assert.deepEqual(lifecycle, { close: 1, processTree: 1, terminate: 1, release: 1 });
  }

  {
    const lifecycle: Lifecycle = { close: 0, processTree: 0, terminate: 0, release: 0 };
    const ensureInputs: AcpRuntimeEnsureInput[] = [];
    const candidate = { model: "cursor/opaque:model+thinking", effort: null } as const;
    const postSelectionOptions = [{
      type: "select", id: "model", name: "Model", currentValue: candidate.model,
      options: [{ value: candidate.model, name: "Opaque" }],
    }] as SessionConfigOption[];
    const observation = await observeAcpHarness({ harness: AgentRunHarness.Cursor, inspect: candidate }, {
      readRuntimeProvenance: async () => provenance,
      createRuntime: () => leasedRuntime(
        async () => ({ sessionKey: "probe", backend: "acpx", runtimeSessionName: "probe" }),
        async () => ({
          models: { currentModelId: candidate.model, availableModelIds: [candidate.model] },
          details: { configOptions: postSelectionOptions },
        }),
        lifecycle,
        true,
        async () => undefined,
        { ensureInputs },
      ),
    });
    assert.deepEqual(ensureInputs[0]?.sessionOptions, { model: candidate.model });
    assert.deepEqual(observation.requestedInspection, candidate, "explicit null effort survives unchanged");
    assert.deepEqual(observation.confirmation, { model: candidate.model });
    assert.equal(observation.session?.configOptions, postSelectionOptions);
  }

  {
    const lifecycle: Lifecycle = { close: 0, processTree: 0, terminate: 0, release: 0 };
    const requestedCandidate = { model: "requested", effort: null } as const;
    const observation = await observeAcpHarness({
      harness: AgentRunHarness.Codex,
      inspect: requestedCandidate,
    }, {
      readRuntimeProvenance: async () => provenance,
      createRuntime: () => leasedRuntime(
        async () => ({ sessionKey: "probe", backend: "acpx", runtimeSessionName: "probe" }),
        async () => ({
          models: { currentModelId: "silent-fallback", availableModelIds: ["requested", "silent-fallback"] },
          details: { configOptions: [] },
        }),
        lifecycle,
      ),
    });
    assert.deepEqual(observation.requestedInspection, requestedCandidate);
    assert.equal(observation.confirmation, null, "a mismatch can never become false confirmation");
    assert.match(observation.error ?? "", /ACP_SELECTION_MODEL_MISMATCH/);
    assert.deepEqual(lifecycle, { close: 1, processTree: 1, terminate: 1, release: 1 });
  }

  {
    const lifecycle: Lifecycle = { close: 0, processTree: 0, terminate: 0, release: 0 };
    const stateDir = join(temp, "success");
    mkdirSync(stateDir);
    const observation = await observeAcpHarness({ harness: AgentRunHarness.Codex }, {
      now: () => new Date(OBSERVED_AT),
      probeStateDir: stateDir,
      readRuntimeProvenance: async () => provenance,
      createRuntime: () => leasedRuntime(
        async () => ({ sessionKey: "probe", backend: "acpx", runtimeSessionName: "probe" }),
        async () => ({
          models: { currentModelId: "gpt-ticket-03", availableModelIds: ["gpt-ticket-03"] },
          details: { configOptions: completeOptions },
        }),
        lifecycle,
      ),
    });
    assert.equal(observation.error, null);
    assert.equal(observation.observedAt, OBSERVED_AT);
    assert.deepEqual(observation.runtime, provenance);
    assert.equal(
      observation.session?.configOptions,
      completeOptions,
      "complete ACP option objects pass through without cloning or field loss",
    );
    assert.deepEqual(lifecycle, { close: 1, processTree: 1, terminate: 1, release: 1 });
    assert.equal(existsSync(stateDir), false, "a successful observation removes its throwaway store");
  }

  {
    const lifecycle: Lifecycle = { close: 0, processTree: 0, terminate: 0, release: 0 };
    const observation = await observeAcpHarness({ harness: AgentRunHarness.Codex }, {
      readRuntimeProvenance: async () => provenance,
      createRuntime: () => leasedRuntime(
        async () => ({ sessionKey: "probe", backend: "acpx", runtimeSessionName: "probe" }),
        async () => ({ details: { configOptions: { malformed: true } } }),
        lifecycle,
      ),
    });
    assert.match(observation.error ?? "", /ACP_CONFIG_OPTIONS_INVALID/);
    assert.equal(observation.session, null, "malformed present state never becomes capability truth");
    assert.deepEqual(lifecycle, { close: 1, processTree: 1, terminate: 1, release: 1 });
  }

  {
    const lifecycle: Lifecycle = { close: 0, processTree: 0, terminate: 0, release: 0 };
    const observation = await observeAcpHarness({ harness: AgentRunHarness.Codex }, {
      timeoutMs: 5,
      readRuntimeProvenance: async () => provenance,
      createRuntime: () => leasedRuntime(
        async () => await new Promise(() => undefined),
        async () => ({}),
        lifecycle,
      ),
    });
    assert.match(observation.error ?? "", /timed out during initialization/);
    assert.deepEqual(
      lifecycle,
      { close: 0, processTree: 0, terminate: 1, release: 1 },
      "initialization timeout still terminates and releases the leased process",
    );
  }

  {
    const lifecycle: Lifecycle = { close: 0, processTree: 0, terminate: 0, release: 0 };
    const stateDir = join(temp, "unconfirmed-cleanup");
    mkdirSync(stateDir);
    const observation = await observeAcpHarness({ harness: AgentRunHarness.Codex }, {
      probeStateDir: stateDir,
      readRuntimeProvenance: async () => provenance,
      createRuntime: () => leasedRuntime(
        async () => ({ sessionKey: "probe", backend: "acpx", runtimeSessionName: "probe" }),
        async () => ({
          models: { currentModelId: "gpt-ticket-03", availableModelIds: ["gpt-ticket-03"] },
          details: { configOptions: completeOptions },
        }),
        lifecycle,
        false,
      ),
    });
    assert.match(observation.error ?? "", /cleanup could not be confirmed/);
    assert.equal(lifecycle.release, 0, "an unconfirmed process tree keeps its durable lease");
    assert.equal(existsSync(stateDir), true, "an unconfirmed process tree keeps its store as evidence");
  }

  {
    const lifecycle: Lifecycle = { close: 0, processTree: 0, terminate: 0, release: 0 };
    const stateDir = join(temp, "hung-close");
    mkdirSync(stateDir);
    const startedAt = Date.now();
    const observation = await observeAcpHarness({ harness: AgentRunHarness.Codex }, {
      closeTimeoutMs: 5,
      probeStateDir: stateDir,
      readRuntimeProvenance: async () => provenance,
      createRuntime: () => leasedRuntime(
        async () => ({ sessionKey: "probe", backend: "acpx", runtimeSessionName: "probe" }),
        async () => ({
          models: { currentModelId: "gpt-ticket-03", availableModelIds: ["gpt-ticket-03"] },
          details: { configOptions: completeOptions },
        }),
        lifecycle,
        true,
        async () => await new Promise(() => undefined),
      ),
    });
    assert.equal(observation.error, null, "authoritative termination makes a hung graceful close clean");
    assert.ok(Date.now() - startedAt < 500, "a never-settling graceful close is bounded");
    assert.deepEqual(lifecycle, { close: 1, processTree: 1, terminate: 1, release: 1 });
    assert.equal(existsSync(stateDir), false, "termination still removes the throwaway store");
  }

  const registry = readAcpRegistryProvenance();
  assert.equal(registry.acpxVersion, "0.13.1");
  assert.ok(registry.registeredAgentNames.includes("claude"));
  assert.ok(registry.registeredAgentNames.includes("codex"));
  assert.ok(registry.registeredAgentNames.includes("cursor"));

  const claude = await readAcpRuntimeProvenance(AgentRunHarness.ClaudeCode);
  assert.deepEqual(claude, {
    acpxVersion: "0.13.1",
    adapter: {
      packageName: "@agentclientprotocol/claude-agent-acp",
      packageVersion: "0.70.0",
      resolution: "package-lock",
    },
    backend: {
      name: "@anthropic-ai/claude-agent-sdk",
      version: "0.3.232",
      source: "adapter-dependency",
    },
  });
  const codex = await readAcpRuntimeProvenance(AgentRunHarness.Codex);
  assert.equal(codex.backend.version, "0.148.0", "backend resolves relative to the adapter, not Promptfoo");
  const cursor = await readAcpRuntimeProvenance(AgentRunHarness.Cursor, {
    resolveCursorCommand: () => "/fixture/cursor-agent",
    readCommandVersion: async (command) => {
      assert.equal(command, "/fixture/cursor-agent");
      return "cursor-agent 9.8.7";
    },
  });
  assert.deepEqual(cursor.adapter, { packageName: null, packageVersion: null, resolution: "path" });
  assert.deepEqual(cursor.backend, {
    name: "cursor-agent",
    version: "cursor-agent 9.8.7",
    source: "path-command",
  });

  process.stdout.write("ok — ACP capability observation preserves full state, exact provenance, timeouts, and cleanup\n");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
