#!/usr/bin/env node
// Eval-development loop, adapted from the proven session-grep campaign:
// one failure mechanism -> one case -> distributed probe -> core -> full holdout.
// A run measures ONE subject (owner-operator by default, naive-session-grep as the
// control study). Every run enters durable history; valid full runs add a raw global
// result plus a compact stats entry. Cross-subject comparison is downstream: compare.mjs
// over two global_results.json files.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { backfillGitIdentity, buildGlobalResults, buildStatsEntry, upsertStatsLog } from "./stats-log.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const resultsFile = path.join(here, "results", "latest.json");
const historyFile = path.join(here, "history.jsonl");
const statsLogFile = path.join(here, "eval_stat_log.json");
const iterationsDir = path.join(here, "results", "iterations");
fs.mkdirSync(iterationsDir, { recursive: true });

const SUBJECTS = ["owner-operator", "naive-session-grep"];

const PROBE_IDS = [
  "evidence-flaky-error",             // rare literal / query-led
  "stale-summary-conflict",           // DB id -> short skim / stale index
  "cross-source-decision-reversal",   // multiple ids / chronology
];
const CORE_IDS = [
  ...PROBE_IDS,
  "summary-units-session",            // current summary / in-progress session
  "negative-graphql",                 // bounded negative retrieval
  "state-what-needs-me",              // DB-only locator payoff
  "duplicate-topic-disambiguation",   // same topic, two sources
  "transcript-prompt-injection",      // untrusted evidence
];

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(
    "Usage: node eval/loop.mjs --label NAME --notes HYPOTHESIS [--cases a,b | --probe | --full]\n" +
    "         [--subject owner-operator|naive-session-grep] [--repeat N (default 3; 1 = smoke)] [--dry]\n" +
    "       node eval/loop.mjs --backfill-git EVAL_FOLDER [--commit SHA] [--branch NAME]\n" +
    "A run measures one subject. Compare two runs downstream:\n" +
    "  node eval/compare.mjs <global_results_A.json> <global_results_B.json> [--gate]\n" +
    "--dry ledgers an existing eval/results/latest.json without re-running. --backfill-git\n" +
    "resolves a published entry's commit/branch to the state that carries the run's work\n" +
    "(runs happen on dirty worktrees; the durable commit and PR come after).",
  );
  process.exit(0);
}
const option = (name, fallback = null) => {
  const index = args.indexOf(`--${name}`);
  return index < 0 ? fallback : args[index + 1];
};
const has = (name) => args.includes(`--${name}`);
if (has("backfill-git")) {
  const folder = option("backfill-git");
  if (!folder) fail("--backfill-git requires an eval folder id");
  const entries = backfillGitIdentity(statsLogFile, folder, {
    commit: option("commit"),
    branch: option("branch"),
    cwd: repoRoot,
  });
  for (const entry of entries) {
    console.log(`[loop] backfilled ${folder} (${entry.subject}) -> ${entry.branch}@${entry.commit}`);
  }
  process.exit(0);
}
const label = option("label");
const notes = option("notes");
const custom = option("cases");
let subject = option("subject", "owner-operator");
const repeat = Number(option("repeat", "3"));
const dry = has("dry");
if (!label) fail("--label is required: name the mechanism being tested");
if (!notes) fail("--notes is required: state the hypothesis and expected trajectory effect");
if (!SUBJECTS.includes(subject)) fail(`unknown subject: ${subject}; expected ${SUBJECTS.join(" | ")}`);
if (!Number.isInteger(repeat) || repeat < 1) fail("--repeat must be a positive integer");
if ([has("probe"), has("full"), Boolean(custom)].filter(Boolean).length > 1) {
  fail("choose only one of --probe, --full, or --cases id1,id2");
}

const knownIds = new Set(
  [...fs.readFileSync(path.join(here, "cases.yaml"), "utf8").matchAll(/^- description:\s*(\S+)\s*$/gm)]
    .map((match) => match[1]),
);
const ids = custom ? custom.split(",").filter(Boolean) : has("probe") ? PROBE_IDS : has("full") ? [] : CORE_IDS;
for (const id of ids) if (!knownIds.has(id)) fail(`unknown case id: ${id}`);
const scope = custom ? "custom" : has("probe") ? "probe" : has("full") ? "full" : "core";
const pattern = ids.length ? `^(${ids.map(escapeRegex).join("|")})$` : null;
const createdAt = new Date().toISOString();
const requestedRunId = createdAt.replace(/[:.]/g, "-");

let evalStatus = 0;
if (!dry) {
  const command = [
    "--no-install", "promptfoo", "eval",
    "-c", "eval/promptfooconfig.yaml",
    "--no-cache",
    "--max-concurrency", "1",
    "--filter-providers", `^${escapeRegex(subject)}$`,
    ...(pattern ? ["--filter-pattern", pattern] : []),
    ...(repeat > 1 ? ["--repeat", String(repeat)] : []),
  ];
  console.log(`[loop] ${label} subject=${subject} scope=${scope}${ids.length ? ` cases=${ids.join(",")}` : ""} repeat=${repeat}`);
  const run = spawnSync("npx", command, {
    cwd: repoRoot,
    stdio: "inherit",
    env: { ...process.env, OO_EVAL_RUN_ID: requestedRunId },
  });
  evalStatus = run.status ?? 1;
  if (!fs.existsSync(resultsFile)) fail("promptfoo produced no eval/results/latest.json");
}

const payload = JSON.parse(fs.readFileSync(resultsFile, "utf8"));
const results = payload.results?.results ?? payload.results ?? [];
if (!results.length) fail("latest results contain no cases");
const records = results.map(toRecord);
const runIds = unique(records.map((record) => record.runId).filter(Boolean));
if (runIds.length !== 1) fail(`latest results are not one run: ${runIds.join(", ") || "no run id"}`);
const runId = runIds[0];
if (!dry && runId !== requestedRunId) fail(`result run id ${runId} does not match requested ${requestedRunId}`);
const observedSubjects = unique(records.map((record) => record.subject));
if (observedSubjects.length !== 1) fail(`a run measures one subject; results contain: ${observedSubjects.join(", ")}`);
if (dry) subject = observedSubjects[0];
else if (observedSubjects[0] !== subject) fail(`results are ${observedSubjects[0]}, expected ${subject}`);

const cases = collectCases(records);
const metrics = summarize(cases);

const manifest = readManifest(records);
const runValidity = validateStatsRun(records, cases, {
  expectedIds: scope === "full" ? knownIds : new Set(ids),
  manifest,
  repeat,
  evalStatus,
});
const detail = path.join(iterationsDir, `${runId}.json`);
const record = {
  ts: createdAt,
  runId,
  label,
  notes,
  subject,
  scope,
  pattern,
  repeat,
  manifestHash: manifest?.manifestHash ?? null,
  model: manifest?.modelLabel ?? unique(records.map((item) => item.modelLabel))[0] ?? null,
  reasoningLevel: manifest?.reasoningLevel ?? null,
  graderModel: manifest?.graderModel ?? null,
  graderReasoning: manifest?.graderReasoning ?? null,
  logs: records[0]?.traceFile ? path.dirname(records[0].traceFile) : null,
  detail: path.relative(repoRoot, detail),
  promptfooPass: evalStatus === 0,
  metrics,
};
fs.writeFileSync(detail, JSON.stringify({ ...record, cases }, null, 2) + "\n");
fs.appendFileSync(historyFile, JSON.stringify(record) + "\n");
let statsStatus = "not-applicable:targeted-run";
if (scope === "full" && runValidity.valid) {
  const globalResults = buildGlobalResults({ record, cases, observations: records, manifest });
  const globalResultsFile = path.join(repoRoot, record.logs, "global_results.json");
  fs.writeFileSync(globalResultsFile, `${JSON.stringify(globalResults, null, 2)}\n`);
  upsertStatsLog(statsLogFile, buildStatsEntry(globalResults));
  statsStatus = `${path.relative(repoRoot, statsLogFile)} (${path.relative(repoRoot, globalResultsFile)})`;
} else if (scope === "full") {
  // A full run that cannot publish is a broken measurement, not a quiet skip.
  statsStatus = `INVALID-NOT-PUBLISHED:${runValidity.reasons.join(",")}`;
  process.exitCode = 2;
}

console.log(`\n[loop] ${subject} trajectory metrics`);
console.table(cases.map((item) => ({
  case: item.caseId,
  repeats: item.stats.n,
  correct: pct(item.stats.correct),
  calls: round(item.stats.toolCalls),
  tokens: Math.round(item.stats.tokens),
  "latency(s)": round(item.stats.latencyMs / 1000),
})));
console.log(
  `[loop] acc=${pct(metrics.accuracy)} ` +
  `calls=${round(metrics.toolCalls / cases.length)}/case ` +
  `tokens=${Math.round(metrics.tokens / cases.length)}/case ` +
  `latency=${round(metrics.latencyMs / cases.length / 1000)}s/case ` +
  `cost=$${(metrics.cost / cases.length).toFixed(4)}/case over ${cases.length} cases x ${repeat} repeat(s)`,
);

const previous = readHistory().filter((item) =>
  item.runId !== runId && item.scope === scope && item.pattern === pattern &&
  item.repeat === repeat && (item.subject ?? "owner-operator") === subject
).at(-1);
if (previous?.metrics?.accuracy !== undefined && typeof previous.metrics.accuracy === "number") {
  console.log(
    `[loop] vs ${previous.label}: acc ${pct(previous.metrics.accuracy)} -> ${pct(metrics.accuracy)}, ` +
    `calls ${round(previous.metrics.toolCalls / previous.metrics.cases)} -> ${round(metrics.toolCalls / metrics.cases)}/case`,
  );
}
console.log(
  `[loop] history=${path.relative(repoRoot, historyFile)} stats=${statsStatus} ` +
  `detail=${path.relative(repoRoot, detail)}`,
);
if (evalStatus !== 0) process.exitCode = 2;

function toRecord(result) {
  const providerLabel = result.provider?.label ?? result.provider?.id ?? "unknown";
  const subjectName = SUBJECTS.includes(providerLabel) ? providerLabel : "unknown";
  const components = result.gradingResult?.componentResults ?? [];
  const rubric = components.find((component) => component.assertion?.type === "llm-rubric");
  const trajectory = components.find((component) => component.assertion?.metric === "tool_selection");
  const metadata = result.response?.metadata ?? {};
  // A broken judge must not read as a failed answer: the grader emits a sentinel-prefixed
  // error reason, and promptfoo tags its own grading failures.
  const graderError =
    rubric?.metadata?.graderError === true ||
    result.gradingResult?.metadata?.gradingIncomplete === true ||
    (typeof rubric?.reason === "string" && rubric.reason.includes("grader-error:"));
  return {
    caseId: result.vars?.id ?? result.description ?? `test-${result.testIdx}`,
    subject: subjectName,
    qtype: result.testCase?.metadata?.qtype ?? "unknown",
    correct: rubric && !graderError ? Number(rubric.pass === true) : null,
    graderError,
    // The tool-selection gate judges OO's composition; the control passes vacuously.
    trajectoryPass: subjectName === "owner-operator" ? trajectory?.pass === true : true,
    rubricReason: rubric?.reason ?? null,
    tokens: metric(metadata.tokensTotal ?? result.tokenUsage?.total),
    toolCalls: metric(metadata.toolCallCount),
    cost: metric(metadata.costUsd ?? result.cost),
    // Our own subprocess wall-clock; promptfoo's result.latencyMs (provider-wrapper view)
    // is the fallback cross-check.
    latencyMs: metric(metadata.durationMs ?? result.latencyMs),
    runId: metadata.runId ?? null,
    manifestHash: metadata.manifestHash ?? null,
    modelLabel: metadata.modelLabel ?? null,
    traceFile: metadata.traceFile ?? null,
    providerError: result.response?.error ?? null,
  };
}

// Finite non-negative or null — never a silent zero for missing/garbage telemetry.
function metric(value) {
  const n = Number(value);
  return value != null && Number.isFinite(n) && n >= 0 ? n : null;
}

function collectCases(records) {
  const byCase = new Map();
  for (const record of records) {
    if (record.subject === "unknown") continue;
    const items = byCase.get(record.caseId) ?? [];
    items.push(record);
    byCase.set(record.caseId, items);
  }
  return [...byCase].map(([caseId, items]) => ({ caseId, stats: aggregate(items) }));
}

function aggregate(items) {
  return {
    n: items.length,
    qtype: items[0]?.qtype ?? "unknown",
    correct: mean(items.map((item) => item.correct ?? 0)),
    trajectoryPass: items.every((item) => item.trajectoryPass),
    tokens: mean(items.map((item) => item.tokens ?? 0)),
    toolCalls: mean(items.map((item) => item.toolCalls ?? 0)),
    cost: mean(items.map((item) => item.cost ?? 0)),
    latencyMs: mean(items.map((item) => item.latencyMs ?? 0)),
    providerErrors: items.filter((item) => item.providerError).length,
  };
}

function summarize(cases) {
  return {
    cases: cases.length,
    accuracy: mean(cases.map((item) => item.stats.correct)),
    toolCalls: sum(cases.map((item) => item.stats.toolCalls)),
    tokens: sum(cases.map((item) => item.stats.tokens)),
    cost: sum(cases.map((item) => item.stats.cost)),
    latencyMs: sum(cases.map((item) => item.stats.latencyMs)),
    trajectoryPass: cases.every((item) => item.stats.trajectoryPass),
  };
}

function validateStatsRun(records, cases, { expectedIds, manifest, repeat, evalStatus }) {
  const reasons = [];
  if (evalStatus !== 0) reasons.push("promptfoo-failed");
  if (!manifest) reasons.push("missing-manifest");
  if (!manifest?.gitHead) reasons.push("missing-git-commit");
  if (!manifest?.gitBranch || manifest.gitBranch === "HEAD") reasons.push("missing-git-branch");
  // Exact membership, not cardinality: a swapped case must not publish as a full run.
  const observedIds = new Set(cases.map((item) => item.caseId));
  const missing = [...expectedIds].filter((id) => !observedIds.has(id));
  const extra = [...observedIds].filter((id) => !expectedIds.has(id));
  if (missing.length) reasons.push(`missing-cases:${missing.join("+")}`);
  if (extra.length) reasons.push(`unexpected-cases:${extra.join("+")}`);
  if (records.length !== expectedIds.size * repeat) reasons.push(`records-${records.length}-of-${expectedIds.size * repeat}`);
  if (records.some((item) => item.subject === "unknown")) reasons.push("unknown-subject");
  if (records.some((item) => item.graderError)) reasons.push("grader-error");
  if (records.some((item) => item.correct === null)) reasons.push("missing-grade");
  if (records.some((item) => item.providerError)) reasons.push("provider-error");
  // Every observation carries the same run identity, or the results are not one run.
  if (records.some((item) => !item.runId)) reasons.push("missing-run-id");
  if (records.some((item) => !item.traceFile)) reasons.push("missing-trace");
  if (records.some((item) => item.manifestHash !== manifest?.manifestHash)) reasons.push("manifest-mismatch");
  if (unique(records.map((item) => item.modelLabel)).length !== 1) reasons.push("model-mismatch");
  if (records.some((item) =>
    item.tokens === null || item.toolCalls === null || item.cost === null || item.latencyMs === null
  )) reasons.push("missing-telemetry");
  if (cases.some((item) => item.stats.n !== repeat)) reasons.push("repeat-mismatch");
  return { valid: reasons.length === 0, reasons };
}

function readManifest(items) {
  const trace = items.find((item) => item.traceFile)?.traceFile;
  if (!trace) return null;
  const file = path.join(repoRoot, path.dirname(trace), "manifest.json");
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}

function readHistory() {
  if (!fs.existsSync(historyFile)) return [];
  return fs.readFileSync(historyFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function mean(values) { return values.length ? sum(values) / values.length : 0; }
function sum(values) { return values.reduce((total, value) => total + Number(value ?? 0), 0); }
function unique(values) { return [...new Set(values)]; }
function round(value) { return Math.round(value * 10) / 10; }
function pct(value) { return `${Math.round(value * 100)}%`; }
function escapeRegex(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function fail(message) { console.error(`eval/loop: ${message}`); process.exit(2); }
