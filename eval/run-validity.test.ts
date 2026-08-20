import assert from "node:assert";
import { shouldWriteGlobalResults, validateEvalRun } from "./run-validity.mjs";

const manifest = {
  gitHead: "abcdef1234567890abcdef1234567890abcdef12",
  gitBranch: "fix/129-real-harness-evals",
  manifestHash: "manifest-a",
};
const record = {
  caseId: "delegated-child-confidently-finished",
  subject: "owner-operator-behavioral",
  correct: 0,
  graderError: false,
  trajectoryPresent: true,
  trajectoryWellFormed: true,
  trajectoryPass: false,
  behavioralStatePresent: true,
  tokens: 20,
  toolCalls: 0,
  cost: 0.01,
  latencyMs: 100,
  runId: "run-a",
  manifestHash: "manifest-a",
  modelLabel: "provider/model",
  traceFile: "eval/results/logs/run-a/case.trace.ndjson",
  providerError: null,
  harnessValid: true,
};
const cases = [{ caseId: record.caseId, stats: { n: 1 } }];
const options = { expectedIds: new Set([record.caseId]), manifest, repeat: 1, scope: "behavioral" };

assert.equal(shouldWriteGlobalResults("behavioral"), true);
assert.equal(shouldWriteGlobalResults("full"), true);
assert.equal(shouldWriteGlobalResults("probe"), false);
assert.deepEqual(
  validateEvalRun([record], cases, options),
  { valid: true, reasons: [] },
  "a target-case grade failure remains valid baseline evidence",
);

const missingTrajectory = validateEvalRun(
  [{ ...record, correct: null, trajectoryPresent: false, trajectoryWellFormed: false, trajectoryPass: null }],
  cases,
  options,
);
assert.equal(missingTrajectory.valid, false);
assert.ok(missingTrajectory.reasons.includes("missing-behavioral-trajectory"));
assert.ok(missingTrajectory.reasons.includes("malformed-behavioral-trajectory"));

const invalidHarness = validateEvalRun([{ ...record, harnessValid: false }], cases, options);
assert.equal(invalidHarness.valid, false);
assert.ok(invalidHarness.reasons.includes("invalid-behavioral-harness"));

const missingState = validateEvalRun([{ ...record, behavioralStatePresent: false }], cases, options);
assert.equal(missingState.valid, false);
assert.ok(missingState.reasons.includes("missing-behavioral-state"));

process.stdout.write("ok — eval run validity: behavioral grades may fail, harness/trajectory wiring may not\n");
