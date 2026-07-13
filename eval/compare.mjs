#!/usr/bin/env node
// Downstream comparison of two published runs.
//
//   node eval/compare.mjs <global_results_A.json> <global_results_B.json> [--gate]
//
// Each run measured one subject; loop.mjs writes its global_results.json under
// results/logs/<run>/. This script pairs the two runs' per-case results and reports
// pass-rate and spend deltas (with a qtype breakdown); --gate exits nonzero when A's
// correctness falls below B's on the shared cases. Comparability caveats (different
// model, grader, reasoning, or repeat) are printed, not silently absorbed.

import fs from "node:fs";

const args = process.argv.slice(2);
const gate = args.includes("--gate");
const files = args.filter((arg) => !arg.startsWith("--"));
if (files.length !== 2) {
  console.error("usage: node eval/compare.mjs <global_results_A.json> <global_results_B.json> [--gate]");
  process.exit(2);
}

const [a, b] = files.map((file) => JSON.parse(fs.readFileSync(file, "utf8")));
const describe = (run) => `${run.metadata.subject} [${run.metadata.label ?? run.eval_folder}] @ ${run.metadata.commit}`;
console.log(`A: ${describe(a)}`);
console.log(`B: ${describe(b)}`);

for (const [field, read] of [
  ["model", (run) => run.metadata.model_under_test],
  ["reasoning_level", (run) => run.metadata.reasoning_level],
  ["grader_model", (run) => run.metadata.grader_model],
  ["repeat", (run) => run.metadata.repeat],
]) {
  if (read(a) !== read(b)) {
    console.log(`caveat: ${field} differs (A=${read(a)}, B=${read(b)}) — deltas are not attributable to the subject alone`);
  }
}

const casesA = new Map(a.cases.map((item) => [item.id, item]));
const casesB = new Map(b.cases.map((item) => [item.id, item]));
const shared = [...casesA.keys()].filter((id) => casesB.has(id));
const onlyA = [...casesA.keys()].filter((id) => !casesB.has(id));
const onlyB = [...casesB.keys()].filter((id) => !casesA.has(id));
if (onlyA.length) console.log(`only in A (unpaired, excluded): ${onlyA.join(", ")}`);
if (onlyB.length) console.log(`only in B (unpaired, excluded): ${onlyB.join(", ")}`);
if (!shared.length) {
  console.error("no shared cases to compare");
  process.exit(2);
}

console.table(shared.map((id) => ({
  case: id,
  qtype: casesA.get(id).qtype ?? "-",
  "pass(A)": `${casesA.get(id).pass_rate}%`,
  "pass(B)": `${casesB.get(id).pass_rate}%`,
  "calls(A)": casesA.get(id).mean_tool_calls,
  "calls(B)": casesB.get(id).mean_tool_calls,
  "tokens(A)": Math.round(casesA.get(id).mean_tokens),
  "tokens(B)": Math.round(casesB.get(id).mean_tokens),
})));

const qtypes = unique(shared.map((id) => casesA.get(id).qtype ?? "unknown")).sort();
if (qtypes.length > 1) {
  console.log("— by qtype —");
  console.table(qtypes.map((qtype) => {
    const ids = shared.filter((id) => (casesA.get(id).qtype ?? "unknown") === qtype);
    return {
      qtype,
      n: ids.length,
      "pass(A)": `${passRate(casesA, ids).toFixed(0)}%`,
      "pass(B)": `${passRate(casesB, ids).toFixed(0)}%`,
      "calls(A)": round(meanOf(casesA, ids, "mean_tool_calls")),
      "calls(B)": round(meanOf(casesB, ids, "mean_tool_calls")),
    };
  }));
}

const rateA = passRate(casesA, shared);
const rateB = passRate(casesB, shared);
console.log(
  `shared cases: ${shared.length} | pass A=${rateA.toFixed(2)}% B=${rateB.toFixed(2)}% | ` +
  `calls/case A=${meanOf(casesA, shared, "mean_tool_calls").toFixed(2)} B=${meanOf(casesB, shared, "mean_tool_calls").toFixed(2)} | ` +
  `tokens/case A=${Math.round(meanOf(casesA, shared, "mean_tokens"))} B=${Math.round(meanOf(casesB, shared, "mean_tokens"))} | ` +
  `cost/case A=$${meanOf(casesA, shared, "mean_cost_usd").toFixed(4)} B=$${meanOf(casesB, shared, "mean_cost_usd").toFixed(4)}`,
);

if (gate && rateA < rateB) {
  console.error(`gate: FAIL — A correctness ${rateA.toFixed(2)}% is below B ${rateB.toFixed(2)}%`);
  process.exit(2);
}
if (gate) console.log(`gate: PASS — A correctness ${rateA.toFixed(2)}% >= B ${rateB.toFixed(2)}%`);

function passRate(caseMap, ids) {
  const cases = ids.map((id) => caseMap.get(id));
  const tests = cases.reduce((total, item) => total + item.repeat, 0);
  const passed = cases.reduce((total, item) => total + item.total_pass, 0);
  return tests ? (passed / tests) * 100 : 0;
}
function meanOf(caseMap, ids, field) {
  return ids.reduce((total, id) => total + Number(caseMap.get(id)[field] ?? 0), 0) / ids.length;
}
function unique(values) { return [...new Set(values)]; }
function round(value) { return Math.round(value * 10) / 10; }
