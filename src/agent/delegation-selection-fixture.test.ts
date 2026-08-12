import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../shared/repo-root";

interface Identity { harness: string; model: string; effort: string | null }
interface Case {
  id: string;
  prompt: string;
  roster: string;
  details: Array<{ harness: string; models: Array<{ id: string; reasoningLevels: string[] }> | null }>;
  expectedLaunches: Identity[];
  bypassSelection?: boolean;
  requiresDetails?: boolean;
  requiresFallbackReport?: boolean;
  requiresOwnerQuestion?: boolean;
  requiresUnknownReport?: boolean;
  rejectionReportTerms?: string[];
}

const cases = JSON.parse(readFileSync(join(
  repoRoot,
  "src/agent/fixtures/delegation-selection.behavior-cases.json",
), "utf8")) as Case[];
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
    assert.ok(entry.rejectionReportTerms?.length, `${entry.id} defines fixture-specific rejection semantics`);
  }
  if (entry.requiresOwnerQuestion) assert.equal(entry.expectedLaunches.length, 1, "no fallback launches before owner input");
  for (const launch of entry.expectedLaunches) {
    assert.ok(launch.harness && launch.model && Object.hasOwn(launch, "effort"), `${entry.id} has exact identity`);
  }
}

process.stdout.write(`ok — ${cases.length} delegation behavior fixtures cover exact observable contracts\n`);
