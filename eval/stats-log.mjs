import fs from "node:fs";
import path from "node:path";

export function buildGlobalResults({ record, cases, observations = [], manifest = null }) {
  const gitHead = requiredGitCommit(manifest?.gitHead);
  const branch = requiredGitBranch(manifest?.gitBranch);
  const values = observations.length ? observations : observationsFromCaseMeans(cases);

  return {
    eval_folder: record.runId,
    metadata: {
      timestamp: record.ts,
      label: record.label,
      notes: record.notes,
      scope: record.scope,
      model_under_test: record.model,
      grader_model: record.graderModel,
      reasoning_level: manifest?.reasoningLevel ?? null,
      subject_transport: manifest?.subjectTransport ?? null,
      repeat: record.repeat,
      branch,
      commit: gitHead.slice(0, 7),
      git_head: gitHead,
      git_dirty: Boolean(manifest?.gitStatus?.trim()),
      git_diff_hash: manifest?.gitDiffHash ?? null,
      manifest_hash: record.manifestHash,
      promptfoo_pass: record.promptfooPass ?? null,
      comparison_gate_pass: record.comparePass,
      metric_source: observations.length ? "individual_evaluations" : "case_means",
      detail: record.detail,
    },
    summary: {
      paired_cases: cases.length,
      total_tests_per_arm: totalTests(cases, "oo"),
      owner_operator: summarizeArm(cases, "oo"),
      baseline: summarizeArm(cases, "baseline"),
      comparison_gate_pass: record.comparePass,
      trajectory_pass: record.metrics?.trajectoryPass ?? cases.every((item) => item.oo.trajectoryPass),
      fewer_call_wins: record.metrics?.fewerCallWins ?? null,
    },
    tool_calls: summarizeMetric(values, "toolCalls", 2),
    tokens: summarizeMetric(values, "tokens", 2),
    cost_usd: summarizeMetric(values, "cost", 6),
    cases: cases.map((item) => ({
      id: item.caseId,
      owner_operator: summarizeCaseArm(item.oo),
      baseline: summarizeCaseArm(item.baseline),
    })),
  };
}

export function buildStatsEntry(globalResults) {
  const metadata = globalResults?.metadata ?? {};
  if (metadata.scope !== "full") {
    throw new Error("eval stats log only accepts full-suite snapshots");
  }
  requiredGitBranch(metadata.branch);
  requiredShortCommit(metadata.commit);
  if (!globalResults?.eval_folder) throw new Error("eval stats snapshot requires an eval folder");

  return {
    timestamp: metadata.timestamp,
    commit: metadata.commit,
    branch: metadata.branch,
    git_dirty: metadata.git_dirty,
    git_diff_hash: metadata.git_diff_hash,
    eval_folder: globalResults.eval_folder,
    model: metadata.model_under_test,
    grader_model: metadata.grader_model,
    reasoning_level: metadata.reasoning_level,
    scope: metadata.scope,
    repeat: metadata.repeat,
    summary: globalResults.summary,
    tool_calls: globalResults.tool_calls,
    tokens: globalResults.tokens,
    cost_usd: globalResults.cost_usd,
  };
}

export function upsertStatsLog(file, entry) {
  requiredGitBranch(entry?.branch);
  requiredShortCommit(entry?.commit);
  if (entry?.scope !== "full") throw new Error("eval stats log only accepts full-suite snapshots");
  if (!entry?.eval_folder) throw new Error("eval stats snapshot requires an eval folder");

  let existing = [];
  if (fs.existsSync(file)) {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Array.isArray(parsed)) throw new Error(`${file} must contain a JSON array`);
    existing = parsed;
  }

  const entries = [
    entry,
    ...existing.filter((item) => item.eval_folder !== entry.eval_folder),
  ];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(entries, null, 2)}\n`);
}

function summarizeMetric(observations, field, places) {
  return {
    owner_operator: distribution(
      observations.filter((item) => normalizeArm(item.arm) === "oo").map((item) => item[field]),
      places,
    ),
    baseline: distribution(
      observations.filter((item) => normalizeArm(item.arm) === "baseline").map((item) => item[field]),
      places,
    ),
  };
}

function distribution(rawValues, places) {
  const values = rawValues.map(Number).filter(Number.isFinite).sort((left, right) => left - right);
  if (!values.length) {
    return { mean: null, median: null, min: null, max: null, stdev: null, total_requests: 0 };
  }
  const average = mean(values);
  const middle = Math.floor(values.length / 2);
  const median = values.length % 2
    ? values[middle]
    : (values[middle - 1] + values[middle]) / 2;
  const variance = values.length > 1
    ? sum(values.map((value) => (value - average) ** 2)) / (values.length - 1)
    : 0;
  return {
    mean: round(average, places),
    median: round(median, places),
    min: round(values[0], places),
    max: round(values.at(-1), places),
    stdev: round(Math.sqrt(variance), places),
    total_requests: values.length,
  };
}

function observationsFromCaseMeans(cases) {
  const output = [];
  for (const item of cases) {
    for (const arm of ["oo", "baseline"]) {
      const value = item[arm];
      for (let index = 0; index < value.n; index++) {
        output.push({
          arm,
          toolCalls: value.toolCalls,
          tokens: value.tokens,
          cost: value.cost,
        });
      }
    }
  }
  return output;
}

function summarizeArm(cases, arm) {
  const values = cases.map((item) => item[arm]);
  const tests = totalTests(cases, arm);
  const passed = sum(values.map((item) => Math.round(item.correct * item.n)));
  const errors = sum(values.map((item) => item.providerErrors ?? 0));
  return {
    total_pass: passed,
    total_fail: Math.max(0, tests - passed - errors),
    total_error: errors,
    global_pass_rate: percentage(passed, tests),
  };
}

function summarizeCaseArm(value) {
  const passed = Math.round(value.correct * value.n);
  const errors = value.providerErrors ?? 0;
  return {
    repeat: value.n,
    total_pass: passed,
    total_fail: Math.max(0, value.n - passed - errors),
    total_error: errors,
    pass_rate: percentage(passed, value.n),
    trajectory_pass: value.trajectoryPass,
    mean_tool_calls: round(value.toolCalls, 2),
    mean_tokens: round(value.tokens, 2),
    mean_cost_usd: round(value.cost, 6),
  };
}

function totalTests(cases, arm) {
  return sum(cases.map((item) => item[arm].n));
}

function normalizeArm(value) {
  return value === "owner-operator" ? "oo" : value;
}

function requiredGitCommit(value) {
  const commit = typeof value === "string" ? value.trim() : "";
  if (!/^[0-9a-f]{7,40}$/i.test(commit)) {
    throw new Error("eval stats snapshot requires a Git commit hash");
  }
  return commit;
}

function requiredShortCommit(value) {
  const commit = typeof value === "string" ? value.trim() : "";
  if (!/^[0-9a-f]{7,40}$/i.test(commit)) {
    throw new Error("eval stats snapshot requires a Git commit hash");
  }
  return commit;
}

function requiredGitBranch(value) {
  const branch = typeof value === "string" ? value.trim() : "";
  if (!branch || branch === "HEAD") {
    throw new Error("eval stats snapshot requires a Git branch");
  }
  return branch;
}

function percentage(part, total) {
  return total ? round((part / total) * 100, 2) : 0;
}

function mean(values) {
  return values.length ? sum(values) / values.length : 0;
}

function round(value, places = 6) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** places;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function sum(values) {
  return values.reduce((total, value) => total + Number(value ?? 0), 0);
}
