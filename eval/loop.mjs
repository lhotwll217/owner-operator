#!/usr/bin/env node
// Eval-development loop, adapted from the proven session-grep campaign:
// one failure mechanism -> one case -> distributed probe -> core -> full holdout.
// Writes experiment history; valid full runs add raw global results plus a compact PR stats entry.

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
    "         [--repeat N (default 3; 1 = smoke)] [--naive-session-grep-compare] [--dry]\n" +
    "       node eval/loop.mjs --backfill-git EVAL_FOLDER [--commit SHA] [--branch NAME]\n" +
    "Default runs the owner-operator arm only; --naive-session-grep-compare adds the\n" +
    "grep-baseline arm for a paired A/B (issue #31 style). --dry ledgers an existing\n" +
    "eval/results/latest.json without re-running. --backfill-git re-points a published\n" +
    "stats entry at the commit/branch that carries the run's work (runs happen on dirty\n" +
    "worktrees; the durable commit and PR usually come after).",
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
  const entry = backfillGitIdentity(statsLogFile, folder, {
    commit: option("commit"),
    branch: option("branch"),
    cwd: repoRoot,
  });
  console.log(`[loop] backfilled ${folder} -> ${entry.branch}@${entry.commit} (run-time identity kept as ${entry.run_branch}@${entry.run_commit})`);
  process.exit(0);
}
const label = option("label");
const notes = option("notes");
const custom = option("cases");
const repeat = Number(option("repeat", "3"));
const dry = has("dry");
if (!label) fail("--label is required: name the mechanism being tested");
if (!notes) fail("--notes is required: state the hypothesis and expected trajectory effect");
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
let withBaseline = has("naive-session-grep-compare");
const createdAt = new Date().toISOString();
const requestedRunId = createdAt.replace(/[:.]/g, "-");

let evalStatus = 0;
if (!dry) {
  const command = [
    "--no-install", "promptfoo", "eval",
    "-c", "eval/promptfooconfig.yaml",
    "--no-cache",
    "--max-concurrency", "1",
    ...(withBaseline ? [] : ["--filter-providers", "owner-operator"]),
    ...(pattern ? ["--filter-pattern", pattern] : []),
    ...(repeat > 1 ? ["--repeat", String(repeat)] : []),
  ];
  console.log(`[loop] ${label} scope=${scope} arms=${withBaseline ? "oo+baseline" : "oo"}${ids.length ? ` cases=${ids.join(",")}` : ""} repeat=${repeat}`);
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
if (dry) withBaseline = records.some((record) => record.arm === "baseline");

const pairs = collectCases(records, withBaseline);
const metrics = summarize(pairs, withBaseline);
const compare = withBaseline
  ? spawnSync(process.execPath, ["eval/compare.mjs", resultsFile, "--gate"], {
    cwd: repoRoot,
    encoding: "utf8",
  })
  : null;
if (compare) {
  process.stdout.write(compare.stdout);
  process.stderr.write(compare.stderr);
}

const manifest = readManifest(records);
const runValidity = validateStatsRun(records, pairs, {
  expectedCases: scope === "full" ? knownIds.size : ids.length,
  manifest,
  repeat,
  withBaseline,
});
const detail = path.join(iterationsDir, `${runId}.json`);
const record = {
  ts: createdAt,
  runId,
  label,
  notes,
  scope,
  arms: withBaseline ? "oo+baseline" : "oo",
  pattern,
  repeat,
  manifestHash: manifest?.manifestHash ?? null,
  model: manifest?.modelLabel ?? unique(records.map((item) => item.modelLabel))[0] ?? null,
  graderModel: manifest?.graderModel ?? null,
  logs: records[0]?.traceFile ? path.dirname(records[0].traceFile) : null,
  detail: path.relative(repoRoot, detail),
  promptfooPass: evalStatus === 0,
  comparePass: compare ? compare.status === 0 : null,
  metrics,
};
fs.writeFileSync(detail, JSON.stringify({ ...record, cases: pairs }, null, 2) + "\n");
fs.appendFileSync(historyFile, JSON.stringify(record) + "\n");
let statsStatus = "not-applicable:targeted-run";
if (scope === "full" && runValidity.valid) {
  const globalResults = buildGlobalResults({ record, cases: pairs, observations: records, manifest });
  const globalResultsFile = path.join(repoRoot, record.logs, "global_results.json");
  fs.writeFileSync(globalResultsFile, `${JSON.stringify(globalResults, null, 2)}\n`);
  upsertStatsLog(statsLogFile, buildStatsEntry(globalResults));
  statsStatus = `${path.relative(repoRoot, statsLogFile)} (${path.relative(repoRoot, globalResultsFile)})`;
} else if (scope === "full") {
  // A full run that cannot publish is a broken measurement, not a quiet skip.
  statsStatus = `INVALID-NOT-PUBLISHED:${runValidity.reasons.join(",")}`;
  process.exitCode = 2;
}

console.log(`\n[loop] ${withBaseline ? "paired" : "owner-operator"} trajectory metrics`);
console.table(pairs.map((pair) => ({
  case: pair.caseId,
  repeats: pair.oo.n,
  "correct(oo)": pct(pair.oo.correct),
  ...(withBaseline ? { "correct(base)": pct(pair.baseline.correct) } : {}),
  "calls(oo)": round(pair.oo.toolCalls),
  ...(withBaseline ? { "calls(base)": round(pair.baseline.toolCalls) } : {}),
  "tokens(oo)": Math.round(pair.oo.tokens),
  ...(withBaseline ? { "tokens(base)": Math.round(pair.baseline.tokens) } : {}),
})));
if (withBaseline) {
  console.log(
    `[loop] acc=${pct(metrics.accuracy.oo)} vs ${pct(metrics.accuracy.baseline)} ` +
    `callRatio=${ratio(metrics.toolCalls.oo, metrics.toolCalls.baseline)} ` +
    `tokenRatio=${ratio(metrics.tokens.oo, metrics.tokens.baseline)} ` +
    `costRatio=${ratio(metrics.cost.oo, metrics.cost.baseline)} ` +
    `fewer-call wins=${metrics.fewerCallWins}/${metrics.paired}`,
  );
} else {
  console.log(
    `[loop] acc=${pct(metrics.accuracy.oo)} ` +
    `calls=${round(metrics.toolCalls.oo / pairs.length)}/case ` +
    `tokens=${Math.round(metrics.tokens.oo / pairs.length)}/case ` +
    `cost=$${(metrics.cost.oo / pairs.length).toFixed(4)}/case over ${pairs.length} cases x ${repeat} repeat(s)`,
  );
}

const previousArms = (item) => item.arms ?? "oo+baseline";
const previous = readHistory().filter((item) =>
  item.runId !== runId && item.scope === scope && item.pattern === pattern &&
  item.repeat === repeat && previousArms(item) === record.arms
).at(-1);
if (previous) {
  console.log(
    withBaseline
      ? `[loop] vs ${previous.label}: callRatio ${ratio(previous.metrics.toolCalls.oo, previous.metrics.toolCalls.baseline)} -> ${ratio(metrics.toolCalls.oo, metrics.toolCalls.baseline)}, ` +
        `acc(oo) ${pct(previous.metrics.accuracy.oo)} -> ${pct(metrics.accuracy.oo)}`
      : `[loop] vs ${previous.label}: acc(oo) ${pct(previous.metrics.accuracy.oo)} -> ${pct(metrics.accuracy.oo)}, ` +
        `calls(oo) ${round(previous.metrics.toolCalls.oo / previous.metrics.paired)} -> ${round(metrics.toolCalls.oo / metrics.paired)}/case`,
  );
}
console.log(
  `[loop] history=${path.relative(repoRoot, historyFile)} stats=${statsStatus} ` +
  `detail=${path.relative(repoRoot, detail)}`,
);
if (evalStatus !== 0 || (compare && compare.status !== 0)) process.exitCode = 2;

function toRecord(result) {
  const label = result.provider?.label ?? result.provider?.id ?? "unknown";
  const arm = label.startsWith("owner-operator") ? "oo" : label.startsWith("baseline") ? "baseline" : "unknown";
  const components = result.gradingResult?.componentResults ?? [];
  const rubric = components.find((component) => component.assertion?.type === "llm-rubric");
  const trajectory = components.find((component) => component.assertion?.metric === "tool_selection");
  const metadata = result.response?.metadata ?? {};
  return {
    caseId: result.vars?.id ?? result.description ?? `test-${result.testIdx}`,
    arm,
    correct: rubric ? Number(rubric.pass === true) : null,
    trajectoryPass: arm === "oo" ? trajectory?.pass === true : true,
    rubricReason: rubric?.reason ?? null,
    tokens: Number(metadata.tokensTotal ?? result.tokenUsage?.total ?? 0),
    toolCalls: Number(metadata.toolCallCount ?? 0),
    cost: Number(metadata.costUsd ?? result.cost ?? 0),
    runId: metadata.runId ?? null,
    modelLabel: metadata.modelLabel ?? null,
    traceFile: metadata.traceFile ?? null,
    providerError: result.response?.error ?? null,
  };
}

function collectCases(records, withBaseline) {
  const byCase = new Map();
  for (const record of records) {
    if (record.arm === "unknown") continue;
    const arms = byCase.get(record.caseId) ?? { oo: [], baseline: [] };
    arms[record.arm].push(record);
    byCase.set(record.caseId, arms);
  }
  const output = [];
  for (const [caseId, arms] of byCase) {
    if (!arms.oo.length) continue;
    if (withBaseline && arms.oo.length !== arms.baseline.length) continue;
    output.push({
      caseId,
      oo: aggregate(arms.oo),
      baseline: withBaseline ? aggregate(arms.baseline) : null,
    });
  }
  return output;
}

function aggregate(items) {
  return {
    n: items.length,
    correct: mean(items.map((item) => item.correct ?? 0)),
    trajectoryPass: items.every((item) => item.trajectoryPass),
    tokens: mean(items.map((item) => item.tokens)),
    toolCalls: mean(items.map((item) => item.toolCalls)),
    cost: mean(items.map((item) => item.cost)),
    providerErrors: items.filter((item) => item.providerError).length,
  };
}

function summarize(pairs, withBaseline) {
  return {
    paired: pairs.length,
    accuracy: {
      oo: mean(pairs.map((pair) => pair.oo.correct)),
      baseline: withBaseline ? mean(pairs.map((pair) => pair.baseline.correct)) : null,
    },
    toolCalls: {
      oo: sum(pairs.map((pair) => pair.oo.toolCalls)),
      baseline: withBaseline ? sum(pairs.map((pair) => pair.baseline.toolCalls)) : null,
    },
    tokens: {
      oo: sum(pairs.map((pair) => pair.oo.tokens)),
      baseline: withBaseline ? sum(pairs.map((pair) => pair.baseline.tokens)) : null,
    },
    cost: {
      oo: sum(pairs.map((pair) => pair.oo.cost)),
      baseline: withBaseline ? sum(pairs.map((pair) => pair.baseline.cost)) : null,
    },
    fewerCallWins: withBaseline
      ? pairs.filter((pair) => pair.oo.toolCalls < pair.baseline.toolCalls).length
      : null,
    trajectoryPass: pairs.every((pair) => pair.oo.trajectoryPass),
  };
}

function validateStatsRun(records, pairs, { expectedCases, manifest, repeat, withBaseline }) {
  const armCount = withBaseline ? 2 : 1;
  const reasons = [];
  if (!manifest) reasons.push("missing-manifest");
  if (!manifest?.gitHead) reasons.push("missing-git-commit");
  if (!manifest?.gitBranch || manifest.gitBranch === "HEAD") reasons.push("missing-git-branch");
  if (pairs.length !== expectedCases) reasons.push(`paired-cases-${pairs.length}-of-${expectedCases}`);
  if (records.length !== expectedCases * repeat * armCount) reasons.push(`records-${records.length}-of-${expectedCases * repeat * armCount}`);
  if (records.some((item) => item.arm === "unknown")) reasons.push("unknown-arm");
  if (records.some((item) => item.correct === null)) reasons.push("missing-grade");
  if (records.some((item) => item.providerError)) reasons.push("provider-error");
  if (pairs.some((item) => item.oo.n !== repeat || (withBaseline && item.baseline.n !== repeat))) reasons.push("repeat-mismatch");
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
function ratio(a, b) { return b > 0 ? (a / b).toFixed(2) : "-"; }
function escapeRegex(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function fail(message) { console.error(`eval/loop: ${message}`); process.exit(2); }
