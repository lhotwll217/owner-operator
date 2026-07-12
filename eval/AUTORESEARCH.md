# Eval iteration protocol

This is a development harness, not a one-shot scorecard. It adapts the proven loop in the
local `session-grep/eval/AUTORESEARCH.md` and the Amplify MCP branch's generic-client
pattern: the subject sees the real product surface, trajectories show how it used that
surface, and each iteration changes one mechanism.

Put campaign-specific claims, expected trajectory changes, and selected cases in a file
under [`hypotheses/`](hypotheses/). Keep this protocol agnostic to any one hypothesis.

## Iteration loop

```text
1. Observe     a real/synthetic trajectory and record one causal finding.
2. Hypothesize one product mechanism and its expected trajectory change.
3. Run         one affected case.
4. Probe       three distributed cases.
5. Core        eight train cases for accept/reject.
6. Holdout     all cases only after the lower rungs support the mechanism.
7. Verify      the same behavior manually through the live headless route.
```

Commands:

```sh
node eval/loop.mjs --cases <case-id> \
  --label "<mechanism>" \
  --notes "<hypothesis and expected trajectory change>"

node eval/loop.mjs --probe --label "<mechanism> probe" --notes "<probe claim>"
node eval/loop.mjs --label "<mechanism> core" --notes "<accept/reject claim>"
node eval/loop.mjs --full --repeat 3 --label "<campaign> holdout" --notes "<final claim>"
```

Every loop run writes:

- `eval/history.jsonl` — append-only autoresearch ledger for labels, hypotheses, provenance,
  aggregate outcomes, and artifact pointers; related to but not replaced by the stats log.
- `eval/results/iterations/<run>.json` — per-case detail.
- `eval/results/logs/<run>/` — full model, tool, stderr, and daemon trajectories.

The researcher writes causal diagnoses and decisions with private trajectory pointers to the
ignored `eval/findings.jsonl`; the loop cannot infer those findings. Promote durable, sanitized
conclusions into the active hypothesis.

A valid, complete `--full` run additionally writes
`eval/results/logs/<run>/global_results.json` and prepends its compact summary to
`eval/eval_stat_log.json`. This follows ai-backend's established raw-result → diff-friendly-log
pattern. The committed entry records timestamp, short commit, branch, dirty-worktree content hash,
eval folder, model/grader, repeat count, pass rates, and call/token/cost distributions. Reprocessing the same eval folder is
idempotent; distinct full runs remain in the log even when they share a branch and commit.
Targeted, probe, core, incomplete, and provider-invalid runs never enter it.

## Campaign closeout

When the evidence is sufficient, stop running LLM evals and aggregate the campaign in its
hypothesis file:

- status and product decision;
- accepted and rejected mechanisms;
- accepted global-result pointer and normalized outcome;
- limitations/confounds;
- follow-ups that must earn a new campaign if they recur.

Keep run-by-run findings and private trajectory pointers in the append-only/local artifacts; do
not duplicate that chronology into the durable summary.

## Admission rule: an eval earns its place

A permanent case must have:

- a real failure mode or product invariant it uniquely represents;
- frozen ground truth that another case does not already cover;
- an observable trajectory assertion when the route matters;
- a reason it belongs in train/core versus untouched holdout;
- a finding or issue pointer explaining what regression it catches.

Do not add cases merely because they are difficult. Do not edit holdout-driven keywords
into product prompts. A model, grader, fixture corpus, or rubric change starts a new
comparison campaign.

## Accept/reject

- Correctness is a veto: no paired case may regress and the fail-closed comparator must pass.
- A model/provider error invalidates the campaign. Circuit-break remaining subject calls; do
  not spend grader tokens scoring empty answers or interpret quota/auth failures as product data.
- Inspect paired per-case tool calls, tokens, cost, and trajectory—not aggregate means alone.
- Compare mean calls, tokens, and cost per evaluation. Totals and per-repeat sums scale with
  suite size or repeat count and therefore do not belong in the PR comparison artifact.
- A global claim must select the intended accepted full entry for the current PR and an entry
  from the previous PR using branch, commit, and eval folder—not merely adjacent timestamps.
  Do not merge targeted runs with different manifests into a synthetic global snapshot. Compare
  the shared case cohort when suites differ, report added cases separately, and disclose changes
  to model, grader, fixtures, assertions, transport, and repeat count.
- Prefer mechanisms that improve the real product/tool surface over eval-only behavioral
  coaching or arbitrary call budgets.
- For disputed LLM-judge outcomes, inspect the rendered grading prompt and repeat the case;
  distinguish grader error from subject error before changing product behavior.
- Record accepted and rejected mechanisms in `findings.jsonl`; do not rewrite history.
