import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../shared/repo-root";
import { parseDelegationBehaviorFixtures } from "./delegation-selection-fixtures";
import { requiredReasonTerms } from "./delegation-selection-grading";

const fixtureSource = readFileSync(join(
  repoRoot,
  "src/agent/fixtures/delegation-selection.behavior-cases.json",
), "utf8");
const cases = parseDelegationBehaviorFixtures(fixtureSource);
const ids = new Set(cases.map((entry) => entry.id));

assert.equal(ids.size, cases.length, "behavior case ids are unique");
for (const required of [
  "explicit-null-bypass",
  "allowance-pressure",
  "stale-advertisement-fallback",
  "invalid-harness-model-pairing",
  "availability-rejection",
  "cross-harness-fallback",
  "unknown-usage-honesty",
  "no-quality-preserving-fallback",
]) assert.ok(ids.has(required), `fixture covers ${required}`);

for (const entry of cases) {
  assert.ok(entry.prompt && entry.roster && entry.expectedLaunches.length > 0);
  if (entry.bypassSelection) {
    assert.equal(entry.expectedLaunches[0]?.effort, null, "the explicit-null bypass is observable");
    assert.equal(entry.requiresDetails, undefined, "complete explicit identity bypasses evidence lookup");
  }
  if (entry.requiresFallbackReport) {
    assert.ok(entry.expectedLaunches.length > 1);
    assert.ok(entry.reject, `${entry.id} defines a fallback rejection`);
    assert.ok(requiredReasonTerms(entry.reject.reason).length, `${entry.id} rejection has gradeable semantics`);
  }
  if (entry.requiresOwnerQuestion) assert.equal(entry.expectedLaunches.length, 1, "no fallback launches before owner input");
  for (const launch of entry.expectedLaunches) {
    assert.ok(launch.harness && launch.model && Object.hasOwn(launch, "effort"), `${entry.id} has exact identity`);
  }
}

assert.deepEqual(requiredReasonTerms("account access rejected the advertised model"),
  ["account", "access", "rejected", "advertised", "model"],
  "fallback grading derives independent semantic terms from the actual rejection reason");

for (const malformed of [
  fixtureSource.replace('"usedPercent": 98', '"usedPercentage": 98'),
  fixtureSource.replace('"allowanceWindows": null', '"allowanceWindows": [{"id":"weekly","usedPercent":101}]'),
  fixtureSource.replace('"effort": null', '"effort": "turbo"'),
]) assert.throws(() => parseDelegationBehaviorFixtures(malformed), /malformed delegation behavior fixture/);

process.stdout.write(`ok — ${cases.length} delegation behavior fixtures cover exact observable contracts\n`);
