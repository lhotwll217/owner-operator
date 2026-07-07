#!/usr/bin/env node
// Issue-#31 gate + report. Reads the promptfoo results JSON, pairs each case across the
// two arms, and checks the success criteria:
//
//   correctness: owner-operator >= baseline overall (the issue's parity-or-better bar)
//   spend:       tokens / tool calls / cost per arm, overall and broken down by qtype —
//                the qtype breakdown is where the DB-as-locator payoff shows up (fewer
//                tool calls on state/stale/audit/handoff cases). Reported, not gated —
//                both arms run the same model, so spend is attributable to composition.
//
//   node eval/compare.mjs [results.json] [--gate]
//
// Default path: eval/results/latest.json. With --gate, exits non-zero when correctness
// parity fails (CI / iteration loop). Adapted from session-grep's compare.mjs.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const gate = args.includes('--gate');
const file = args.find((a) => !a.startsWith('--')) ?? path.join(here, 'results', 'latest.json');

const OO = 'owner-operator';
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const results = data.results?.results ?? data.results ?? [];
if (!results.length) {
  console.error(`No results found in ${file}`);
  process.exit(1);
}

const records = results.map((r) => {
  const label = r.provider?.label ?? r.provider?.id ?? 'unknown';
  const m = r.response?.metadata ?? {};
  const rubric = (r.gradingResult?.componentResults ?? []).find((c) => c.assertion?.type === 'llm-rubric');
  return {
    caseId: r.vars?.id ?? `test-${r.testIdx}`,
    arm: label.startsWith(OO) ? OO : 'baseline',
    qtype: r.testCase?.metadata?.qtype ?? 'unknown',
    correct: rubric ? (rubric.pass ? 1 : 0) : null,
    cost: m.costUsd ?? r.cost ?? 0,
    tokens: m.tokensTotal ?? r.tokenUsage?.total ?? 0,
    toolCalls: m.toolCallCount ?? 0,
    turns: m.numTurns ?? 0,
    error: r.error ?? null,
  };
});

// One row per (case, arm); repeats average instead of clobbering.
const byCase = new Map();
for (const r of records) {
  if (!byCase.has(r.caseId)) byCase.set(r.caseId, {});
  const arms = byCase.get(r.caseId);
  if (!arms[r.arm]) arms[r.arm] = { ...r, n: 1 };
  else {
    const a = arms[r.arm];
    a.n++;
    for (const k of ['cost', 'tokens', 'toolCalls', 'turns']) a[k] += r[k];
    a.correct = (a.correct ?? 0) + (r.correct ?? 0);
  }
}
for (const arms of byCase.values()) {
  for (const a of Object.values(arms)) {
    for (const k of ['cost', 'tokens', 'toolCalls', 'turns']) a[k] /= a.n;
    a.correct = a.correct === null ? null : a.correct / a.n;
  }
}

const rows = [];
const sums = { [OO]: zero(), baseline: zero() };
for (const [caseId, arms] of byCase) {
  const o = arms[OO];
  const b = arms.baseline;
  if (!o || !b) continue;
  add(sums[OO], o);
  add(sums.baseline, b);
  rows.push({
    case: caseId,
    qtype: o.qtype,
    'ok(oo)': mark(o.correct),
    'ok(base)': mark(b.correct),
    'tok(oo)': Math.round(o.tokens),
    'tok(base)': Math.round(b.tokens),
    'calls(oo)': round1(o.toolCalls),
    'calls(base)': round1(b.toolCalls),
  });
}

console.log(`\n═══ owner-operator vs baseline — ${rows.length} paired cases ═══`);
console.table(rows);

const oAcc = sums[OO].n ? sums[OO].correct / sums[OO].n : 0;
const bAcc = sums.baseline.n ? sums.baseline.correct / sums.baseline.n : 0;
console.log(`correctness  owner-operator ${(oAcc * 100).toFixed(0)}%  vs  baseline ${(bAcc * 100).toFixed(0)}%   (criterion: oo >= baseline)`);
console.log(`tokens       ${Math.round(sums[OO].tokens)} vs ${Math.round(sums.baseline.tokens)}   ratio=${ratio(sums[OO].tokens, sums.baseline.tokens)}`);
console.log(`tool calls   ${round1(sums[OO].toolCalls)} vs ${round1(sums.baseline.toolCalls)}   ratio=${ratio(sums[OO].toolCalls, sums.baseline.toolCalls)}`);
console.log(`cost         $${sums[OO].cost.toFixed(3)} vs $${sums.baseline.cost.toFixed(3)}   (same model — spend tracks composition)`);

// Where the DB earns its keep: per-qtype tool-call counts. state/stale/audit/handoff are
// the locate-led cases; fewer OO tool calls there is the locator payoff.
const qtypes = [...new Set(records.map((r) => r.qtype))].sort();
const breakdown = qtypes.map((q) => {
  const oo = [...byCase.values()].map((a) => a[OO]).filter((r) => r?.qtype === q);
  const bs = [...byCase.values()].map((a) => a.baseline).filter((r) => r?.qtype === q);
  return {
    qtype: q,
    n: oo.length,
    'acc(oo)': pct(oo),
    'acc(base)': pct(bs),
    'calls(oo)': round1(mean(oo, 'toolCalls')),
    'calls(base)': round1(mean(bs, 'toolCalls')),
  };
});
console.log('\n— by qtype —');
console.table(breakdown);

const pass = oAcc >= bAcc;
console.log(`\nGATE: ${pass ? 'PASS' : 'FAIL'} — correctness oo >= baseline`);
if (gate && !pass) process.exit(2);

function zero() { return { cost: 0, tokens: 0, toolCalls: 0, correct: 0, n: 0 }; }
function add(acc, r) {
  acc.cost += r.cost; acc.tokens += r.tokens; acc.toolCalls += r.toolCalls;
  acc.correct += r.correct ?? 0; acc.n++;
}
function mark(c) { return c === null ? '?' : c ? 'Y' : 'N'; }
function ratio(a, b) { return b > 0 ? (a / b).toFixed(2) : '-'; }
function round1(x) { return Math.round(x * 10) / 10; }
function mean(rs, k) { return rs.length ? rs.reduce((t, r) => t + r[k], 0) / rs.length : 0; }
function pct(rs) {
  const g = rs.filter((r) => r && r.correct !== null);
  return g.length ? `${((g.reduce((t, r) => t + r.correct, 0) / g.length) * 100).toFixed(0)}%` : '-';
}
