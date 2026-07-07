#!/usr/bin/env node
// Issue-#31 gate + report. Reads the promptfoo results JSONs, pairs each comparative
// case across arms, and checks the success criteria:
//
//   correctness: owner-operator >= baseline on the comparative cases,
//                AND 100% on the OO-only (DB) cases when that results file exists
//   spend:       reported for the owner's eyes (tokens/tool calls/cost per arm) —
//                informational, not gated, since the arms run different models
//
//   node eval/compare.mjs [--gate]
//
// Reads eval/results/latest-compare.json and, if present, eval/results/latest-oo.json.
// With --gate, exits non-zero when a criterion fails (CI / iteration loop).
// Adapted from session-grep's compare.mjs (the proven pairing/report pattern).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const gate = process.argv.includes('--gate');

const OO = 'owner-operator';

function loadRecords(file) {
  if (!fs.existsSync(file)) return null;
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const results = data.results?.results ?? data.results ?? [];
  return results.map((r) => {
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
}

let allPass = true;

// ---- comparative cases: OO vs baseline ----------------------------------------------
const cmp = loadRecords(path.join(here, 'results', 'latest-compare.json'));
if (cmp?.length) {
  const byCase = new Map();
  for (const r of cmp) {
    if (!byCase.has(r.caseId)) byCase.set(r.caseId, {});
    byCase.get(r.caseId)[r.arm] = r; // repeats: last write wins; use promptfoo --repeat + means if needed
  }
  const rows = [];
  const sums = { [OO]: { cost: 0, tokens: 0, calls: 0, correct: 0, n: 0 }, baseline: { cost: 0, tokens: 0, calls: 0, correct: 0, n: 0 } };
  for (const [caseId, arms] of byCase) {
    const o = arms[OO];
    const b = arms.baseline;
    if (!o || !b) continue;
    for (const [k, r] of [[OO, o], ['baseline', b]]) {
      sums[k].cost += r.cost; sums[k].tokens += r.tokens; sums[k].calls += r.toolCalls;
      sums[k].correct += r.correct ?? 0; sums[k].n++;
    }
    rows.push({
      case: caseId,
      'ok(oo)': o.correct === null ? '?' : o.correct ? 'Y' : 'N',
      'ok(base)': b.correct === null ? '?' : b.correct ? 'Y' : 'N',
      'tok(oo)': o.tokens,
      'tok(base)': b.tokens,
      'calls(oo)': o.toolCalls,
      'calls(base)': b.toolCalls,
    });
  }
  console.log(`\n═══ comparative: owner-operator vs baseline — ${rows.length} paired cases ═══`);
  console.table(rows);
  const oAcc = sums[OO].n ? sums[OO].correct / sums[OO].n : 0;
  const bAcc = sums.baseline.n ? sums.baseline.correct / sums.baseline.n : 0;
  console.log(`correctness  owner-operator ${(oAcc * 100).toFixed(0)}%  vs  baseline ${(bAcc * 100).toFixed(0)}%   (criterion: oo >= baseline)`);
  console.log(`tokens       ${sums[OO].tokens} vs ${sums.baseline.tokens}   tool calls ${sums[OO].calls} vs ${sums.baseline.calls}`);
  console.log(`cost         $${sums[OO].cost.toFixed(3)} vs $${sums.baseline.cost.toFixed(3)}   (informational — different models)`);
  const pass = oAcc >= bAcc;
  console.log(`COMPARATIVE GATE: ${pass ? 'PASS' : 'FAIL'}`);
  if (!pass) allPass = false;
} else {
  console.log('no comparative results (eval/results/latest-compare.json) — run the compare eval first');
}

// ---- OO-only cases: absolute correctness ---------------------------------------------
const oo = loadRecords(path.join(here, 'results', 'latest-oo.json'));
if (oo?.length) {
  const rows = oo.map((r) => ({
    case: r.caseId,
    qtype: r.qtype,
    ok: r.correct === null ? '?' : r.correct ? 'Y' : 'N',
    tokens: r.tokens,
    calls: r.toolCalls,
    error: r.error ? String(r.error).slice(0, 60) : '',
  }));
  console.log(`\n═══ OO-only (DB) cases — ${rows.length} ═══`);
  console.table(rows);
  const graded = oo.filter((r) => r.correct !== null);
  const acc = graded.length ? graded.reduce((t, r) => t + r.correct, 0) / graded.length : 0;
  const pass = acc === 1;
  console.log(`OO-ONLY GATE: ${pass ? 'PASS' : 'FAIL'} — ${(acc * 100).toFixed(0)}% (criterion: 100%)`);
  if (!pass) allPass = false;
}

console.log(`\nOVERALL: ${allPass ? 'PASS' : 'FAIL'}`);
if (gate && !allPass) process.exit(2);
