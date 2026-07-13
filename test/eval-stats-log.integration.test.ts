// Integration: raw single-subject global result -> compact append-only stats entry,
// with PR-time git backfill and (eval_folder, subject) idempotent upserts.
import assert from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  backfillGitIdentity,
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
  subject: "owner-operator",
  scope: "full",
  pattern: null,
  repeat: 3,
  manifestHash: "manifest-a",
  model: "subject-model",
  reasoningLevel: "medium",
  graderModel: "grader-model",
  graderReasoning: "minimal",
  logs: "eval/results/logs/run-repeat-3",
  detail: "eval/results/iterations/run-repeat-3.json",
  promptfooPass: true,
  metrics: { trajectoryPass: true },
};

const cases = [
  {
    caseId: "alpha",
    stats: { n: 3, qtype: "evidence", correct: 2 / 3, trajectoryPass: true, tokens: 100, toolCalls: 3, cost: 0.1, latencyMs: 4000, providerErrors: 0 },
  },
  {
    caseId: "beta",
    stats: { n: 3, qtype: "state", correct: 1, trajectoryPass: true, tokens: 50, toolCalls: 2, cost: 0.05, latencyMs: 2000, providerErrors: 0 },
  },
];

const observations = [
  [2, 90, 0.09, 3800],
  [3, 100, 0.1, 4000],
  [4, 110, 0.11, 4200],
  [1, 40, 0.04, 1800],
  [2, 50, 0.05, 2000],
  [3, 60, 0.06, 2200],
].map(([toolCalls, tokens, cost, latencyMs]) => ({ toolCalls, tokens, cost, latencyMs }));

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
  assert.match(loopSource, /INVALID-NOT-PUBLISHED/, "an unpublishable full run fails loudly");
  assert.match(loopSource, /missing-git-commit/);
  assert.match(loopSource, /missing-git-branch/);

  const provenanceSource = readFileSync(join(process.cwd(), "eval", "providers", "git-provenance.mjs"), "utf8");
  assert.match(provenanceSource, /gitBranch:/, "the run manifest must capture the PR branch");

  const globalResults = buildGlobalResults({ record, cases, observations, manifest });
  assert.equal(globalResults.eval_folder, "run-repeat-3");
  assert.equal(globalResults.metadata.subject, "owner-operator");
  assert.equal(globalResults.metadata.branch, "feature/pr-eval-stats");
  assert.equal(globalResults.metadata.commit, "abcdef1");
  assert.equal(globalResults.metadata.repeat, 3);
  assert.equal(globalResults.metadata.reasoning_level, "medium");
  assert.equal(globalResults.metadata.grader_reasoning, "minimal");
  assert.deepEqual(globalResults.summary, {
    cases: 2,
    total_tests: 6,
    total_pass: 5,
    total_fail: 1,
    total_error: 0,
    global_pass_rate: 83.33,
    trajectory_pass: true,
  });
  assert.deepEqual(globalResults.tool_calls, {
    mean: 2.5,
    median: 2.5,
    min: 1,
    max: 4,
    stdev: 1.05,
  });
  assert.equal(globalResults.tokens.mean, 75);
  assert.equal(globalResults.cost_usd.mean, 0.075);
  assert.deepEqual(globalResults.latency_ms, {
    mean: 3000,
    median: 3000,
    min: 1800,
    max: 4200,
    stdev: 1110,
  }, "latency distribution rides the same observation pipeline as tokens/calls/cost");
  assert.equal(globalResults.cases.length, 2, "per-case detail belongs in the raw global result");
  assert.equal(globalResults.cases[0].qtype, "evidence", "qtype rides along for downstream breakdowns");
  assert.equal(globalResults.cases[0].mean_latency_ms, 4000, "per-case mean latency is recorded");

  const entry = buildStatsEntry(globalResults);
  assert.deepEqual(Object.keys(entry), [
    "timestamp",
    "label",
    "commit",
    "branch",
    "eval_folder",
    "subject",
    "model",
    "reasoning_level",
    "grader_model",
    "grader_reasoning",
    "cases",
    "repeat",
    "total_tests",
    "summary",
    "tool_calls",
    "tokens",
    "cost_usd",
    "latency_ms",
  ]);
  assert.equal(entry.subject, "owner-operator");
  assert.equal(entry.latency_ms.median, 3000, "the compact entry carries the latency distribution");
  assert.equal(entry.cases, 2);
  assert.equal(entry.total_tests, 6, "the entry states how many evaluations backed it");
  assert.ok(!("cases" in entry.summary), "the committed stats log stays compact");
  assert.ok(!("notes" in entry), "autoresearch narrative stays in history");
  assert.ok(!("git_dirty" in entry), "run-time git provenance stays in the raw global result");
  assert.ok(!("scope" in entry), "the log only holds full-suite entries; scope is not a field");

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
  const controlEntry = { ...entry, subject: "naive-session-grep", timestamp: "2026-07-11T12:00:30.000Z" };
  upsertStatsLog(file, controlEntry);
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
  assert.deepEqual(
    log.map((item: { eval_folder: string; subject: string }) => `${item.eval_folder}/${item.subject}`),
    [
      "run-repeat-3/owner-operator",
      "same-branch-new-global-run/owner-operator",
      "run-repeat-3/naive-session-grep",
    ],
    "entries are keyed by (eval_folder, subject)",
  );
  assert.equal(log[0].summary.trajectory_pass, false, "the same run is idempotently refreshed");

  const backfilled = backfillGitIdentity(file, "run-repeat-3", { commit: "1234567", branch: "feature/pr-final" });
  assert.equal(backfilled.length, 2, "every subject entry for the folder resolves together");
  const afterBackfill = JSON.parse(readFileSync(file, "utf8"));
  for (const item of afterBackfill.filter((entry: { eval_folder: string }) => entry.eval_folder === "run-repeat-3")) {
    assert.equal(item.commit, "1234567");
    assert.equal(item.branch, "feature/pr-final");
    assert.ok(!("run_commit" in item), "one resolved identity, not two");
  }
  assert.throws(() => backfillGitIdentity(file, "no-such-folder", { commit: "1234567", branch: "x" }), /no stats entry/);

  const committedLog = JSON.parse(readFileSync(join(process.cwd(), "eval", "eval_stat_log.json"), "utf8"));
  assert.ok(committedLog.length >= 2, "the global artifact must retain pre-work and current snapshots");
  assert.ok(
    committedLog.every((item: { subject?: string }) => typeof item.subject === "string" && item.subject.length > 0),
    "every committed entry names its subject explicitly",
  );

  process.stdout.write("ok — eval stats log: single-subject entries, keyed upserts, git backfill\n");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
