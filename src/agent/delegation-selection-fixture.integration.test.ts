import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../shared/repo-root";
import { parseDelegationBehaviorFixtures } from "./delegation-selection-fixtures";
import {
  relevantDetailsCallIndex,
  requiredReasonTerms,
  successfulCallCompletionIndex,
} from "./delegation-selection-grading";

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

const trajectory = [
  { phase: "start" as const, toolCallId: "details-1", name: "get_harness_details", args: { harnesses: ["claude-code"] } },
  { phase: "end" as const, toolCallId: "details-1", name: "get_harness_details", args: {}, succeeded: true },
  { phase: "start" as const, toolCallId: "launch-1", name: "delegate_agent", args: { harness: "claude-code" } },
  { phase: "end" as const, toolCallId: "launch-1", name: "delegate_agent", args: {}, succeeded: false },
  { phase: "start" as const, toolCallId: "details-2", name: "get_harness_details", args: { harnesses: ["claude-code", "codex"] } },
  { phase: "end" as const, toolCallId: "details-2", name: "get_harness_details", args: {}, succeeded: true },
  { phase: "start" as const, toolCallId: "launch-2", name: "delegate_agent", args: { harness: "codex" } },
];
assert.equal(relevantDetailsCallIndex(trajectory, "claude-code", -1, 2), 1,
  "prelaunch evidence is tied to the exact first harness and call index");
assert.equal(relevantDetailsCallIndex(trajectory, "codex", 3, 6), 5,
  "replacement evidence is refreshed after rejection and before its exact launch index");
assert.equal(relevantDetailsCallIndex(trajectory, "codex", -1, 2), -1,
  "details for another harness cannot grade a launch");
assert.equal(relevantDetailsCallIndex(trajectory, "codex", 5, 6), -1,
  "stale/pre-rejection details cannot grade fallback evidence");

const concurrent = [
  { phase: "start" as const, toolCallId: "details", name: "get_harness_details", args: { harnesses: ["codex"] } },
  { phase: "start" as const, toolCallId: "sibling", name: "read", args: { path: "/tmp/roster" } },
  { phase: "start" as const, toolCallId: "launch", name: "delegate_agent", args: { harness: "codex" } },
  { phase: "end" as const, toolCallId: "details", name: "get_harness_details", args: {}, succeeded: true },
];
assert.equal(relevantDetailsCallIndex(concurrent, "codex", -1, 2), -1,
  "a concurrent details start that completes after launch is not evidence");

const straddlingBoundary = [
  { phase: "start" as const, toolCallId: "details", name: "get_harness_details", args: { harnesses: ["codex"] } },
  { phase: "end" as const, toolCallId: "rejection", name: "delegate_agent", args: {}, succeeded: false },
  { phase: "end" as const, toolCallId: "details", name: "get_harness_details", args: {}, succeeded: true },
  { phase: "start" as const, toolCallId: "replacement", name: "delegate_agent", args: { harness: "codex" } },
];
assert.equal(relevantDetailsCallIndex(straddlingBoundary, "codex", 1, 3), -1,
  "a refresh that starts before rejection completion cannot grade fallback evidence");

for (const path of ["/tmp/selection-skill", "/tmp/roster"]) {
  const lateRead = [
    { phase: "start" as const, toolCallId: "launch", name: "delegate_agent", args: { harness: "codex" } },
    { phase: "start" as const, toolCallId: "read", name: "read", args: { path } },
    { phase: "end" as const, toolCallId: "read", name: "read", args: {}, succeeded: true },
  ];
  assert.equal(successfulCallCompletionIndex(lateRead,
    (event) => event.name === "read" && event.args.path === path, -1, 0), -1,
  `${path}: a read that starts and completes after launch cannot grade prelaunch ordering`);
}

for (const malformed of [
  fixtureSource.replace('"usedPercent": 98', '"usedPercentage": 98'),
  fixtureSource.replace('"allowanceWindows": null', '"allowanceWindows": [{"id":"weekly","usedPercent":101}]'),
  fixtureSource.replace('"effort": null', '"effort": "turbo"'),
]) assert.throws(() => parseDelegationBehaviorFixtures(malformed), /malformed delegation behavior fixture/);

process.stdout.write(`ok — ${cases.length} delegation behavior fixtures cover exact observable contracts\n`);
