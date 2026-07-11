// Integration: mirror ai-backend's raw-global-result -> compact append-only stats pattern.
import assert from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildGlobalResults,
  buildStatsEntry,
  upsertStatsLog,
} from "../eval/stats-log.mjs";

const dir = mkdtempSync(join(tmpdir(), "oo-eval-stats-"));
const file = join(dir, "eval_stat_log.json");

const record = {
  ts: "2026-07-11T12:00:00.000Z",
  runId: "run-repeat-3",
  label: "repeat-aware",
  notes: "prove stats do not depend on repeat=1",
  scope: "full",
  pattern: null,
  repeat: 3,
  manifestHash: "manifest-a",
  model: "subject-model",
  graderModel: "grader-model",
  logs: "eval/results/logs/run-repeat-3",
  detail: "eval/results/iterations/run-repeat-3.json",
  comparePass: true,
  promptfooPass: false,
  metrics: {
    fewerCallWins: 2,
    trajectoryPass: true,
  },
};

const cases = [
  {
    caseId: "alpha",
    oo: { n: 3, correct: 2 / 3, trajectoryPass: true, tokens: 100, toolCalls: 3, cost: 0.1, providerErrors: 0 },
    baseline: { n: 3, correct: 1 / 3, trajectoryPass: true, tokens: 120, toolCalls: 4, cost: 0.12, providerErrors: 0 },
  },
  {
    caseId: "beta",
    oo: { n: 3, correct: 1, trajectoryPass: true, tokens: 50, toolCalls: 2, cost: 0.05, providerErrors: 0 },
    baseline: { n: 3, correct: 1, trajectoryPass: true, tokens: 90, toolCalls: 3, cost: 0.09, providerErrors: 0 },
  },
];

const observations = [
  ...[
    [2, 90, 0.09],
    [3, 100, 0.1],
    [4, 110, 0.11],
    [1, 40, 0.04],
    [2, 50, 0.05],
    [3, 60, 0.06],
  ].map(([toolCalls, tokens, cost]) => ({ arm: "oo", toolCalls, tokens, cost })),
  ...[
    [3, 110, 0.11],
    [4, 120, 0.12],
    [5, 130, 0.13],
    [2, 80, 0.08],
    [3, 90, 0.09],
    [4, 100, 0.1],
  ].map(([toolCalls, tokens, cost]) => ({ arm: "baseline", toolCalls, tokens, cost })),
];

const manifest = {
  gitHead: "abcdef1234567890abcdef1234567890abcdef12",
  gitBranch: "feature/pr-eval-stats",
  gitStatus: " M eval/eval_stat_log.json",
  gitDiffHash: "diff-a",
  subjectTransport: "sse",
};

try {
  const packageJson = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
  assert.match(packageJson.scripts.eval, /eval\/loop\.mjs --full/, "the full command must use the ledgered runner");

  const loopSource = readFileSync(join(process.cwd(), "eval", "loop.mjs"), "utf8");
  assert.match(
    loopSource,
    /if \(scope === "full" && runValidity\.valid\)[\s\S]*buildGlobalResults[\s\S]*global_results\.json[\s\S]*upsertStatsLog/,
    "valid full runs must write a raw global result before the compact stats entry",
  );
  assert.ok(
    loopSource.indexOf("fs.appendFileSync(historyFile") < loopSource.indexOf('if (scope === "full"'),
    "all runs enter durable history before the full-run stats boundary",
  );
  assert.match(loopSource, /missing-git-commit/);
  assert.match(loopSource, /missing-git-branch/);

  const provenanceSource = readFileSync(join(process.cwd(), "eval", "providers", "git-provenance.mjs"), "utf8");
  assert.match(provenanceSource, /gitBranch:/, "the run manifest must capture the PR branch");

  const globalResults = buildGlobalResults({ record, cases, observations, manifest });
  assert.equal(globalResults.eval_folder, "run-repeat-3");
  assert.equal(globalResults.metadata.branch, "feature/pr-eval-stats");
  assert.equal(globalResults.metadata.commit, "abcdef1");
  assert.equal(globalResults.metadata.repeat, 3);
  assert.equal(globalResults.summary.total_tests_per_arm, 6);
  assert.deepEqual(globalResults.summary.owner_operator, {
    total_pass: 5,
    total_fail: 1,
    total_error: 0,
    global_pass_rate: 83.33,
  });
  assert.deepEqual(globalResults.tool_calls.owner_operator, {
    mean: 2.5,
    median: 2.5,
    min: 1,
    max: 4,
    stdev: 1.05,
    total_requests: 6,
  });
  assert.equal(globalResults.tokens.owner_operator.mean, 75);
  assert.equal(globalResults.cost_usd.owner_operator.mean, 0.075);
  assert.equal(globalResults.cases.length, 2, "per-case detail belongs in the raw global result");

  const entry = buildStatsEntry(globalResults);
  assert.deepEqual(Object.keys(entry), [
    "timestamp",
    "commit",
    "branch",
    "git_dirty",
    "git_diff_hash",
    "eval_folder",
    "model",
    "grader_model",
    "reasoning_level",
    "scope",
    "repeat",
    "summary",
    "tool_calls",
    "tokens",
    "cost_usd",
  ]);
  assert.equal(entry.git_dirty, true);
  assert.equal(entry.git_diff_hash, "diff-a");
  assert.ok(!("cases" in entry), "the committed stats log stays compact");
  assert.ok(!("notes" in entry), "autoresearch narrative stays in history");

  assert.throws(
    () => buildGlobalResults({ record, cases, observations, manifest: { gitHead: manifest.gitHead } }),
    /git branch/i,
  );
  assert.throws(
    () => buildGlobalResults({ record, cases, observations, manifest: { gitBranch: manifest.gitBranch } }),
    /git commit/i,
  );
  assert.throws(
    () => buildStatsEntry({ ...globalResults, metadata: { ...globalResults.metadata, scope: "probe" } }),
    /full-suite/i,
  );

  upsertStatsLog(file, entry);
  upsertStatsLog(file, {
    ...entry,
    timestamp: "2026-07-11T12:01:00.000Z",
    eval_folder: "same-branch-new-global-run",
  });
  upsertStatsLog(file, {
    ...entry,
    timestamp: "2026-07-11T12:02:00.000Z",
    summary: { ...entry.summary, trajectory_pass: false },
  });

  const log = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(log.map((item: { eval_folder: string }) => item.eval_folder), [
    "run-repeat-3",
    "same-branch-new-global-run",
  ]);
  assert.equal(log[0].summary.trajectory_pass, false, "the same run is idempotently refreshed");
  assert.equal(log[1].branch, entry.branch, "distinct full runs on one PR branch remain comparable");

  const committedLog = JSON.parse(readFileSync(join(process.cwd(), "eval", "eval_stat_log.json"), "utf8"));
  assert.ok(committedLog.length >= 2, "the global artifact must retain pre-work and current snapshots");
  for (const snapshot of committedLog) {
    assert.equal(snapshot.scope, "full");
    assert.match(snapshot.branch, /\S/);
    assert.match(snapshot.commit, /^[0-9a-f]{7,40}$/i);
    assert.ok(snapshot.git_dirty === null || typeof snapshot.git_dirty === "boolean");
    assert.ok(snapshot.git_diff_hash === null || typeof snapshot.git_diff_hash === "string");
    for (const metric of ["tool_calls", "tokens"]) {
      assert.equal(typeof snapshot[metric].owner_operator.mean, "number");
      assert.equal(typeof snapshot[metric].baseline.mean, "number");
    }
  }

  process.stdout.write("ok — eval stats log mirrors the compact append-only global-run pattern\n");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
