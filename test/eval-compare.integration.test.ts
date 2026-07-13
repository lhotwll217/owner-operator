// Integration: compare.mjs is a downstream report over two published single-subject
// runs — pairing by case id, comparability caveats, and an A>=B correctness gate.
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const repoRoot = process.cwd();
const dir = mkdtempSync(join(tmpdir(), "oo-eval-compare-"));

const caseResult = (id: string, passRate: number, repeat = 3, qtype = "evidence") => ({
  id,
  qtype,
  repeat,
  total_pass: Math.round((passRate / 100) * repeat),
  total_fail: repeat - Math.round((passRate / 100) * repeat),
  total_error: 0,
  pass_rate: passRate,
  trajectory_pass: true,
  mean_tool_calls: 3,
  mean_tokens: 90000,
  mean_cost_usd: 0.08,
  mean_latency_ms: 20000,
});

const run = (subject: string, label: string, cases: ReturnType<typeof caseResult>[], grader = "grader-x") => ({
  eval_folder: `${label}-folder`,
  metadata: {
    timestamp: "2026-07-13T00:00:00.000Z",
    label,
    subject,
    scope: "full",
    model_under_test: "subject-model",
    reasoning_level: "medium",
    grader_model: grader,
    repeat: 3,
    branch: "main",
    commit: "abcdef1",
  },
  summary: {
    cases: cases.length,
    total_tests: cases.length * 3,
    total_pass: cases.reduce((total, item) => total + item.total_pass, 0),
    total_fail: cases.reduce((total, item) => total + item.total_fail, 0),
    total_error: 0,
    global_pass_rate: 100,
    trajectory_pass: true,
  },
  tool_calls: { mean: 3, median: 3, min: 1, max: 7, stdev: 1 },
  tokens: { mean: 90000, median: 90000, min: 50000, max: 170000, stdev: 20000 },
  cost_usd: { mean: 0.08, median: 0.08, min: 0.03, max: 0.17, stdev: 0.03 },
  latency_ms: { mean: 20000, median: 20000, min: 8000, max: 40000, stdev: 6000 },
  cases,
});

const write = (name: string, body: unknown) => {
  const file = join(dir, name);
  writeFileSync(file, JSON.stringify(body, null, 2));
  return file;
};

const compare = (...argv: string[]) =>
  spawnSync(process.execPath, [join(repoRoot, "eval", "compare.mjs"), ...argv], { encoding: "utf8" });

try {
  const subjectFile = write("subject.json", run("owner-operator", "pr-run", [
    caseResult("alpha", 100),
    caseResult("beta", 100, 3, "state"),
    caseResult("only-in-a", 100),
  ]));
  const controlFile = write("control.json", run("naive-session-grep", "control-run", [
    caseResult("alpha", 100),
    caseResult("beta", 67, 3, "state"),
  ], "grader-y"));

  const pass = compare(subjectFile, controlFile, "--gate");
  assert.equal(pass.status, 0, `expected gate pass, got: ${pass.stdout}${pass.stderr}`);
  assert.match(pass.stdout, /A: owner-operator \[pr-run\]/, "the report names subjects explicitly");
  assert.match(pass.stdout, /caveat: grader_model differs/, "comparability caveats are surfaced");
  assert.match(pass.stdout, /only in A \(unpaired, excluded\): only-in-a/, "unpaired cases are reported, not absorbed");
  assert.match(pass.stdout, /qtype/, "the qtype breakdown survives for locator-payoff analysis");
  assert.match(pass.stdout, /latency\/case/, "latency is reported alongside calls/tokens/cost");
  assert.match(pass.stdout, /gate: PASS/);

  const regressed = write("regressed.json", run("owner-operator", "regressed-run", [
    caseResult("alpha", 33),
    caseResult("beta", 67, 3, "state"),
  ]));
  const fail = compare(regressed, controlFile, "--gate");
  assert.equal(fail.status, 2, "the gate fails closed when A's correctness is below B's");
  assert.match(fail.stderr, /gate: FAIL/);

  const noGate = compare(regressed, controlFile);
  assert.equal(noGate.status, 0, "without --gate the report is informational");

  const usage = compare(subjectFile);
  assert.equal(usage.status, 2, "one file is a usage error");

  const disjointA = write("disjoint-a.json", run("owner-operator", "a", [caseResult("x", 100)]));
  const disjointB = write("disjoint-b.json", run("owner-operator", "b", [caseResult("y", 100)]));
  const disjoint = compare(disjointA, disjointB);
  assert.equal(disjoint.status, 2, "zero shared cases fails closed");
  assert.match(disjoint.stderr, /no shared cases/);

  const malformedRun = run("owner-operator", "malformed", [caseResult("alpha", 100)]) as Record<string, unknown>;
  delete (malformedRun.cases as Array<Record<string, unknown>>)[0].repeat;
  (malformedRun.cases as Array<Record<string, unknown>>)[0].mean_tokens = "not-a-number";
  const malformedFile = write("malformed.json", malformedRun);
  const malformed = compare(malformedFile, controlFile, "--gate");
  assert.equal(malformed.status, 2, "malformed input fails closed, never NaN-passes the gate");
  assert.match(malformed.stderr, /invalid run/);
  assert.match(malformed.stderr, /invalid repeat/);
  assert.match(malformed.stderr, /non-finite mean_tokens/);

  process.stdout.write("ok — eval compare: downstream pairing, caveats, and a fail-closed correctness gate\n");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
