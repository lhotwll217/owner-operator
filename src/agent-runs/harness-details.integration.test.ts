import assert from "node:assert";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRunHarness } from "@owner-operator/core";
import { readHarnessDetails, type HarnessCapabilityObservation } from "./harness-details";

const dir = mkdtempSync(join(tmpdir(), "oo-harness-details-"));
const previousOoHome = process.env.OO_HOME;
process.env.OO_HOME = dir;
mkdirSync(join(dir, "workspace"), { recursive: true });
writeFileSync(join(dir, "workspace", "harness-roster.md"), "Owner-authored bytes.\n");

const listing = (): string[] => readdirSync(dir, { recursive: true }) as string[];
const observed = (harness: AgentRunHarness, observedAt: string): HarnessCapabilityObservation => ({
  harness,
  acpxAgent: harness === AgentRunHarness.ClaudeCode ? "claude" : harness,
  observedAt,
  runtime: {
    acpxVersion: "0.13.1",
    adapter: { packageName: null, packageVersion: null, resolution: "path" },
    backend: { name: "fixture", version: "1", source: "path-command" },
  },
  requestedInspection: null,
  session: {
    models: { currentModelId: "fixture", availableModelIds: ["fixture"] },
    configOptions: [],
    usage: null,
  },
  confirmation: null,
  error: null,
});

try {
  const before = listing();
  const firstObservedAt = "2026-08-13T08:00:00.000Z";
  const first = await readHarnessDetails({
    deps: {
      now: () => new Date(firstObservedAt),
      observeCapability: async (harness, at) => observed(harness, at),
      readRegistryProvenance: () => ({ acpxVersion: "0.13.1", registeredAgentNames: [] }),
      readCodexPayloads: async () => ({ account: null, rateLimits: null }),
      readCursorPayloads: async () => ({ about: null, status: null, errors: [] }),
    },
  });
  assert.equal(first.capabilities.harnesses.length, 3);
  assert.equal(first.preferences.content, "Owner-authored bytes.\n");
  assert.deepEqual(listing(), before, "reading the snapshot creates no cache, ledger, or session store");

  const reads: string[] = [];
  const secondObservedAt = "2026-08-13T08:00:01.000Z";
  const second = await readHarnessDetails({
    harnesses: [AgentRunHarness.Codex],
    deps: {
      now: () => new Date(secondObservedAt),
      observeCapability: async (harness, at) => {
        reads.push(harness);
        return { ...observed(harness, at), session: { models: null, configOptions: [], usage: null } };
      },
      readRegistryProvenance: () => ({ acpxVersion: "0.13.1", registeredAgentNames: [] }),
      readCodexPayloads: async () => ({ account: null, rateLimits: null }),
    },
  });
  assert.deepEqual(reads, [AgentRunHarness.Codex], "each call re-observes the requested ACP harness");
  assert.equal(second.observedAt, secondObservedAt);
  assert.equal(second.capabilities.harnesses[0]?.session?.models, null);
  assert.deepEqual(listing(), before, "a repeat observation still persists nothing");

  process.stdout.write("ok — launch-authoritative harness snapshots are ephemeral and re-observed\n");
} finally {
  if (previousOoHome === undefined) delete process.env.OO_HOME;
  else process.env.OO_HOME = previousOoHome;
  rmSync(dir, { recursive: true, force: true });
}
