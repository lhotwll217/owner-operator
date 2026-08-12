import assert from "node:assert";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRunHarness } from "@owner-operator/core";
import {
  CODEX_ACCOUNT_READ,
  CODEX_MODEL_LIST,
  CODEX_RATE_LIMITS_READ,
} from "../../test/fixtures/codex-app-server";
import { readHarnessDetails } from "./harness-details";

const dir = mkdtempSync(join(tmpdir(), "oo-harness-details-"));
const previousOoHome = process.env.OO_HOME;
process.env.OO_HOME = dir;

const listing = (): string[] => {
  try {
    return readdirSync(dir, { recursive: true }) as string[];
  } catch {
    return [];
  }
};

try {
  const before = listing();

  const first = await readHarnessDetails({
    deps: {
      readCodexPayloads: async () => ({
        account: CODEX_ACCOUNT_READ,
        rateLimits: CODEX_RATE_LIMITS_READ,
        models: CODEX_MODEL_LIST,
      }),
      discoverBaselineCandidate: async () => ({
        model: "gpt-5.6-sol",
        effort: "low",
        availableEfforts: ["low", "high"],
      }),
    },
    includeBaselineCandidates: true,
  });
  assert.equal(first.length, 2);
  assert.equal(first[0]?.baselineCandidate?.model, "gpt-5.6-sol");
  assert.deepEqual(
    listing(),
    before,
    "observing harnesses writes nothing: no cache, no candidate, no failure ledger",
  );

  // A second observation must re-read rather than serve a remembered answer.
  const reads: string[] = [];
  const second = await readHarnessDetails({
    harnesses: [AgentRunHarness.Codex],
    deps: {
      readCodexPayloads: async () => {
        reads.push("codex");
        return { account: null, rateLimits: null, models: { data: [] } };
      },
    },
  });
  assert.deepEqual(reads, ["codex"], "every call re-observes the harness");
  assert.deepEqual(second[0]?.models, [], "the second snapshot reflects the new observation, not the first");
  assert.notEqual(
    second[0]?.observedAt,
    undefined,
    "each snapshot stamps its own observation time",
  );
  assert.deepEqual(listing(), before, "a repeat observation still persists nothing");

  process.stdout.write("ok — harness observation is ephemeral and leaves no durable state\n");
} finally {
  if (previousOoHome === undefined) delete process.env.OO_HOME;
  else process.env.OO_HOME = previousOoHome;
  rmSync(dir, { recursive: true, force: true });
}
