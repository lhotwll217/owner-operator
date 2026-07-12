#!/usr/bin/env node
// Paired Owner Operator vs baseline report + fail-closed gate.
//
//   node eval/compare.mjs [results.json] [--gate]
//
// A valid run must contain both arms for every observed case/repeat, no provider or
// grader errors, a passing trajectory assertion, and one shared provenance manifest.
// Correctness must meet the absolute floor, parity overall, and parity per case.

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const args = process.argv.slice(2);
const gate = args.includes("--gate");
const file = args.find((arg) => !arg.startsWith("--")) ?? path.join(here, "results", "latest.json");
const minimumAccuracy = Number(process.env.OO_EVAL_MIN_ACCURACY ?? "0.8");
const OO = "owner-operator";
const BASELINE = "baseline";

const data = JSON.parse(fs.readFileSync(file, "utf8"));
const results = data.results?.results ?? data.results ?? [];
const problems = [];
if (!results.length) problems.push(`no results found in ${file}`);

const records = results.map((result) => {
  const label = result.provider?.label ?? result.provider?.id ?? "unknown";
  const arm = label.startsWith(OO) ? OO : label.startsWith(BASELINE) ? BASELINE : "unknown";
  const components = result.gradingResult?.componentResults ?? [];
  const rubric = components.find((component) => component.assertion?.type === "llm-rubric");
  const toolGate = components.find((component) => component.assertion?.metric === "tool_selection");
  const metadata = result.response?.metadata ?? {};
  // Promptfoo also uses result.error for an assertion's failure reason. A provider failure
  // is carried on the provider response, or has no gradable response/components at all.
  const error = result.response?.error ?? (
    result.error && (!result.response || result.response.output == null || components.length === 0)
      ? result.error
      : null
  );
  return {
    caseId: result.vars?.id ?? `test-${result.testIdx}`,
    testIdx: result.testIdx,
    arm,
    qtype: result.testCase?.metadata?.qtype ?? "unknown",
    correct: rubric ? (rubric.pass ? 1 : 0) : null,
    trajectoryPass: arm === OO ? toolGate?.pass === true : true,
    cost: metadata.costUsd ?? result.cost ?? 0,
    tokens: metadata.tokensTotal ?? result.tokenUsage?.total ?? 0,
    toolCalls: metadata.toolCallCount ?? 0,
    turns: metadata.numTurns ?? 0,
    runId: metadata.runId ?? null,
    manifestHash: metadata.manifestHash ?? null,
    modelLabel: metadata.modelLabel ?? null,
    traceFile: metadata.traceFile ?? null,
    sessionTraceFile: metadata.sessionTraceFile ?? null,
    error,
  };
});

for (const record of records) {
  if (record.arm === "unknown") problems.push(`${record.caseId}: unknown provider arm`);
  if (record.error) problems.push(`${record.caseId}/${record.arm}: provider error: ${record.error}`);
  if (record.correct === null) problems.push(`${record.caseId}/${record.arm}: missing llm-rubric grade`);
  if (record.arm === OO && !record.trajectoryPass) problems.push(`${record.caseId}/${record.arm}: trajectory assertion failed`);
  if (!record.runId || !record.manifestHash || !record.modelLabel || !record.traceFile || !record.sessionTraceFile) {
    problems.push(`${record.caseId}/${record.arm}: missing run provenance`);
  }
  for (const relative of [record.traceFile, record.sessionTraceFile].filter(Boolean)) {
    const absolute = path.join(repoRoot, relative);
    if (!fs.existsSync(absolute)) problems.push(`${record.caseId}/${record.arm}: missing trajectory artifact ${relative}`);
  }
}

const byCase = new Map();
for (const record of records.filter((item) => item.arm !== "unknown")) {
  const arms = byCase.get(record.caseId) ?? { [OO]: [], [BASELINE]: [] };
  arms[record.arm].push(record);
  byCase.set(record.caseId, arms);
}

const rows = [];
const pairs = [];
for (const [caseId, arms] of byCase) {
  if (!arms[OO].length || !arms[BASELINE].length) {
    problems.push(`${caseId}: incomplete arm pair (oo=${arms[OO].length}, baseline=${arms[BASELINE].length})`);
    continue;
  }
  if (arms[OO].length !== arms[BASELINE].length) {
    problems.push(`${caseId}: repeat mismatch (oo=${arms[OO].length}, baseline=${arms[BASELINE].length})`);
    continue;
  }
  const oo = aggregate(arms[OO]);
  const baseline = aggregate(arms[BASELINE]);
  if (oo.correct < baseline.correct) {
    problems.push(`${caseId}: correctness regression (${pct1(oo.correct)} < ${pct1(baseline.correct)})`);
  }
  pairs.push({ caseId, qtype: oo.qtype, oo, baseline });
  rows.push({
    case: caseId,
    qtype: oo.qtype,
    repeats: oo.n,
    "ok(oo)": mark(oo.correct),
    "ok(base)": mark(baseline.correct),
    "tok(oo)": Math.round(oo.tokens / oo.n),
    "tok(base)": Math.round(baseline.tokens / baseline.n),
    "calls(oo)": round1(oo.toolCalls / oo.n),
    "calls(base)": round1(baseline.toolCalls / baseline.n),
  });
}

if (!rows.length) problems.push("zero complete paired cases");
const ooAccuracy = mean(pairs.map((pair) => pair.oo.correct));
const baselineAccuracy = mean(pairs.map((pair) => pair.baseline.correct));
if (ooAccuracy < minimumAccuracy) problems.push(`owner-operator accuracy ${pct1(ooAccuracy)} is below floor ${pct1(minimumAccuracy)}`);
if (ooAccuracy < baselineAccuracy) problems.push(`overall correctness regression ${pct1(ooAccuracy)} < ${pct1(baselineAccuracy)}`);

const runIds = unique(records.map((record) => record.runId).filter(Boolean));
const manifestHashes = unique(records.map((record) => record.manifestHash).filter(Boolean));
const modelLabels = unique(records.map((record) => record.modelLabel).filter(Boolean));
if (runIds.length !== 1) problems.push(`expected one run id, got [${runIds.join(", ") || "none"}]`);
if (manifestHashes.length !== 1) problems.push(`expected one manifest hash, got ${manifestHashes.length}`);
if (modelLabels.length !== 1) problems.push(`expected one model, got [${modelLabels.join(", ") || "none"}]`);
verifyManifest(records, manifestHashes[0], problems);

console.log(`\n═══ owner-operator vs baseline — ${rows.length} paired cases ═══`);
console.table(rows);
console.log(`correctness  owner-operator ${pct1(ooAccuracy)}  vs  baseline ${pct1(baselineAccuracy)}   (floor ${pct1(minimumAccuracy)}, no per-case regressions)`);
console.log(`model        ${modelLabels[0] ?? "unknown"}`);

const totals = {
  [OO]: aggregate(records.filter((record) => record.arm === OO)),
  [BASELINE]: aggregate(records.filter((record) => record.arm === BASELINE)),
};
console.log(`tokens       ${Math.round(totals[OO].tokens)} vs ${Math.round(totals[BASELINE].tokens)}   ratio=${ratio(totals[OO].tokens, totals[BASELINE].tokens)}`);
console.log(`tool calls   ${round1(totals[OO].toolCalls)} vs ${round1(totals[BASELINE].toolCalls)}   ratio=${ratio(totals[OO].toolCalls, totals[BASELINE].toolCalls)}`);
console.log(`cost         $${totals[OO].cost.toFixed(3)} vs $${totals[BASELINE].cost.toFixed(3)}`);

const qtypes = unique(pairs.map((pair) => pair.qtype)).sort();
console.log("\n— by qtype —");
console.table(qtypes.map((qtype) => {
  const selected = pairs.filter((pair) => pair.qtype === qtype);
  return {
    qtype,
    n: selected.length,
    "acc(oo)": pct1(mean(selected.map((pair) => pair.oo.correct))),
    "acc(base)": pct1(mean(selected.map((pair) => pair.baseline.correct))),
    "calls(oo)": round1(mean(selected.map((pair) => pair.oo.toolCalls / pair.oo.n))),
    "calls(base)": round1(mean(selected.map((pair) => pair.baseline.toolCalls / pair.baseline.n))),
  };
}));

const pass = problems.length === 0;
console.log(`\nGATE: ${pass ? "PASS" : "FAIL"}`);
for (const problem of problems) console.log(`  - ${problem}`);
if (gate && !pass) process.exit(2);

function aggregate(items) {
  const n = items.length;
  return {
    n,
    qtype: items[0]?.qtype ?? "unknown",
    correct: n ? mean(items.map((item) => item.correct ?? 0)) : 0,
    cost: sum(items, "cost"),
    tokens: sum(items, "tokens"),
    toolCalls: sum(items, "toolCalls"),
    turns: sum(items, "turns"),
  };
}

function verifyManifest(items, expectedHash, output) {
  const trace = items.find((item) => item.traceFile)?.traceFile;
  if (!trace || !expectedHash) return;
  const manifestPath = path.join(repoRoot, path.dirname(trace), "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    output.push(`missing run manifest: ${manifestPath}`);
    return;
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    output.push(`run manifest is invalid JSON: ${error.message}`);
    return;
  }
  if (manifest.manifestHash !== expectedHash) output.push("run manifest hash does not match provider metadata");
  const { manifestHash, ...body } = manifest;
  if (sha256(JSON.stringify(body)) !== manifestHash) output.push("run manifest content does not match its hash");
  const runIds = unique(items.map((item) => item.runId).filter(Boolean));
  const models = unique(items.map((item) => item.modelLabel).filter(Boolean));
  if (runIds.length === 1 && manifest.runId !== runIds[0]) output.push("run manifest id does not match result metadata");
  if (models.length === 1 && manifest.modelLabel !== models[0]) output.push("run manifest model does not match result metadata");
  if (!manifest.artifacts || Object.keys(manifest.artifacts).length === 0) {
    output.push("run manifest has no artifact hashes");
    return;
  }
  for (const [relative, expected] of Object.entries(manifest.artifacts)) {
    const absolute = path.join(repoRoot, relative);
    if (!fs.existsSync(absolute)) output.push(`manifest artifact is missing: ${relative}`);
    else if (sha256(fs.readFileSync(absolute)) !== expected) output.push(`manifest artifact changed since run: ${relative}`);
  }
}

function sum(items, key) { return items.reduce((total, item) => total + Number(item[key] ?? 0), 0); }
function mean(values) { return values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0; }
function unique(values) { return [...new Set(values)]; }
function round1(value) { return Math.round(value * 10) / 10; }
function ratio(a, b) { return b > 0 ? (a / b).toFixed(2) : "-"; }
function pct1(value) { return `${(value * 100).toFixed(0)}%`; }
function mark(value) { return value >= 0.999 ? "Y" : value <= 0.001 ? "N" : `${Math.round(value * 100)}%`; }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
