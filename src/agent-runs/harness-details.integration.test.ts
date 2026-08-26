import assert from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRunHarness } from "@owner-operator/core";
import {
  readHarnessDetails,
  readUserHarnessPreferences,
  type HarnessCapabilityObservation,
} from "./harness-details";

const dir = mkdtempSync(join(tmpdir(), "oo-harness-details-"));
const previousOoHome = process.env.OO_HOME;
process.env.OO_HOME = dir;
mkdirSync(join(dir, "workspace"), { recursive: true });
const legacyPreferences = join(dir, "workspace", "harness-roster.md");
const canonicalPreferences = join(dir, "workspace", "user-harness-preferences.md");
writeFileSync(legacyPreferences, "Owner-authored bytes.\n");

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
  assert.equal(first.preferences.path, legacyPreferences, "a legacy roster is read in place");
  assert.equal(first.preferences.source, "legacy-harness-roster");
  assert.equal(first.preferences.content, "Owner-authored bytes.\n");
  assert.equal(first.preferences.error, null);
  assert.equal(existsSync(canonicalPreferences), false, "observation never creates the canonical file");
  const afterFirstRead = listing();

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
  assert.deepEqual(listing(), afterFirstRead, "a repeat observation creates no cache, ledger, or session store");

  writeFileSync(canonicalPreferences, "canonical owner prose\n");
  const conflict = await readHarnessDetails({
    harnesses: [AgentRunHarness.ClaudeCode],
    deps: {
      observeCapability: async (harness, at) => observed(harness, at),
      readRegistryProvenance: () => ({ acpxVersion: "0.13.1", registeredAgentNames: [] }),
    },
  });
  assert.equal(conflict.preferences.path, canonicalPreferences, "the canonical file wins when both exist");
  assert.equal(conflict.preferences.source, "user-harness-preferences");
  assert.equal(conflict.preferences.content, "canonical owner prose\n");
  assert.equal(conflict.preferences.error, null);
  assert.equal(readFileSync(legacyPreferences, "utf8"), "Owner-authored bytes.\n", "the legacy file stays untouched");

  const freshDir = mkdtempSync(join(tmpdir(), "oo-harness-details-fresh-"));
  process.env.OO_HOME = freshDir;
  const fresh = readUserHarnessPreferences();
  assert.equal(fresh.source, null, "a fresh install has no owner preference file yet");
  assert.equal(fresh.content, null);
  assert.ok(fresh.error, "an unreadable preference path is an explicit error, not silence");
  rmSync(freshDir, { recursive: true, force: true });
  process.env.OO_HOME = dir;

  process.stdout.write("ok — harness snapshots read owner preferences in place and re-observe capabilities\n");
} finally {
  if (previousOoHome === undefined) delete process.env.OO_HOME;
  else process.env.OO_HOME = previousOoHome;
  rmSync(dir, { recursive: true, force: true });
}
