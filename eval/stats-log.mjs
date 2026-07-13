import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// One run = one subject. The raw global result keeps full run provenance (git state at
// run time, per-case detail); the committed stats entry is a compact single-subject
// snapshot whose commit/branch resolve to the durable state carrying the run's work
// (see backfillGitIdentity). Cross-subject comparison is downstream (compare.mjs).

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
      subject: record.subject,
      scope: record.scope,
      model_under_test: record.model,
      reasoning_level: record.reasoningLevel ?? manifest?.reasoningLevel ?? null,
      grader_model: record.graderModel,
      grader_reasoning: record.graderReasoning ?? manifest?.graderReasoning ?? null,
      subject_transport: manifest?.subjectTransport ?? null,
      repeat: record.repeat,
      branch,
      commit: gitHead.slice(0, 7),
      git_head: gitHead,
      git_dirty: Boolean(manifest?.gitStatus?.trim()),
      git_diff_hash: manifest?.gitDiffHash ?? null,
      manifest_hash: record.manifestHash,
      promptfoo_pass: record.promptfooPass ?? null,
      metric_source: observations.length ? "individual_evaluations" : "case_means",
      detail: record.detail,
    },
    summary: summarizeCases(cases),
    tool_calls: distribution(values.map((item) => item.toolCalls), 2),
    tokens: distribution(values.map((item) => item.tokens), 2),
    cost_usd: distribution(values.map((item) => item.cost), 6),
    latency_ms: distribution(values.map((item) => item.latencyMs), 0),
    cases: cases.map((item) => ({ id: item.caseId, ...summarizeCase(item.stats) })),
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
  if (!metadata.subject) throw new Error("eval stats snapshot requires a subject");

  return {
    timestamp: metadata.timestamp,
    label: metadata.label ?? null,
    commit: metadata.commit,
    branch: metadata.branch,
    eval_folder: globalResults.eval_folder,
    subject: metadata.subject,
    model: metadata.model_under_test,
    reasoning_level: metadata.reasoning_level ?? null,
    grader_model: metadata.grader_model,
    grader_reasoning: metadata.grader_reasoning ?? null,
    cases: globalResults.summary.cases,
    repeat: metadata.repeat,
    total_tests: globalResults.summary.total_tests,
    summary: {
      total_pass: globalResults.summary.total_pass,
      total_fail: globalResults.summary.total_fail,
      total_error: globalResults.summary.total_error,
      global_pass_rate: globalResults.summary.global_pass_rate,
      trajectory_pass: globalResults.summary.trajectory_pass,
    },
    tool_calls: globalResults.tool_calls,
    tokens: globalResults.tokens,
    cost_usd: globalResults.cost_usd,
    latency_ms: globalResults.latency_ms,
  };
}

export function upsertStatsLog(file, entry) {
  requiredGitBranch(entry?.branch);
  requiredShortCommit(entry?.commit);
  if (!entry?.eval_folder) throw new Error("eval stats snapshot requires an eval folder");
  if (!entry?.subject) throw new Error("eval stats snapshot requires a subject");

  let existing = [];
  if (fs.existsSync(file)) {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Array.isArray(parsed)) throw new Error(`${file} must contain a JSON array`);
    existing = parsed;
  }

  const entries = [
    entry,
    ...existing.filter((item) =>
      item.eval_folder !== entry.eval_folder || (item.subject ?? "owner-operator") !== entry.subject,
    ),
  ];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(entries, null, 2)}\n`);
}

/**
 * Runs happen on dirty mid-iteration worktrees; the commit and PR come after. Backfill
 * resolves every entry for an eval folder to the durable state that carries the run's
 * work. Run-time git provenance stays in that run's ignored global_results.json.
 */
export function backfillGitIdentity(file, evalFolder, { commit, branch, cwd } = {}) {
  if (!fs.existsSync(file)) throw new Error(`${file} does not exist`);
  const entries = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(entries)) throw new Error(`${file} must contain a JSON array`);
  const matches = entries.filter((item) => item.eval_folder === evalFolder);
  if (!matches.length) throw new Error(`no stats entry for eval folder: ${evalFolder}`);
  const git = (command) => execSync(command, { cwd: cwd ?? process.cwd(), encoding: "utf8" }).trim();
  const nextCommit = requiredShortCommit(commit ?? git("git rev-parse --short HEAD")).slice(0, 7);
  const nextBranch = requiredGitBranch(branch ?? git("git rev-parse --abbrev-ref HEAD"));
  for (const entry of matches) {
    entry.commit = nextCommit;
    entry.branch = nextBranch;
  }
  fs.writeFileSync(file, `${JSON.stringify(entries, null, 2)}\n`);
  return matches;
}

function summarizeCases(cases) {
  const tests = sum(cases.map((item) => item.stats.n));
  const passed = sum(cases.map((item) => Math.round(item.stats.correct * item.stats.n)));
  const errors = sum(cases.map((item) => item.stats.providerErrors ?? 0));
  return {
    cases: cases.length,
    total_tests: tests,
    total_pass: passed,
    total_fail: Math.max(0, tests - passed - errors),
    total_error: errors,
    global_pass_rate: percentage(passed, tests),
    trajectory_pass: cases.every((item) => item.stats.trajectoryPass),
  };
}

function summarizeCase(stats) {
  const passed = Math.round(stats.correct * stats.n);
  const errors = stats.providerErrors ?? 0;
  return {
    qtype: stats.qtype ?? null,
    repeat: stats.n,
    total_pass: passed,
    total_fail: Math.max(0, stats.n - passed - errors),
    total_error: errors,
    pass_rate: percentage(passed, stats.n),
    trajectory_pass: stats.trajectoryPass,
    mean_tool_calls: round(stats.toolCalls, 2),
    mean_tokens: round(stats.tokens, 2),
    mean_cost_usd: round(stats.cost, 6),
    mean_latency_ms: round(stats.latencyMs, 0),
  };
}

function distribution(rawValues, places) {
  const values = rawValues.map(Number).filter(Number.isFinite).sort((left, right) => left - right);
  if (!values.length) {
    return { mean: null, median: null, min: null, max: null, stdev: null };
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
  };
}

function observationsFromCaseMeans(cases) {
  const output = [];
  for (const item of cases) {
    for (let index = 0; index < item.stats.n; index++) {
      output.push({
        toolCalls: item.stats.toolCalls,
        tokens: item.stats.tokens,
        cost: item.stats.cost,
        latencyMs: item.stats.latencyMs,
      });
    }
  }
  return output;
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
