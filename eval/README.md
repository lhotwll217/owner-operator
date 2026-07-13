# Eval — Owner Operator harness

Measures the Operator's prompt/tool composition on session questions — correctness and
spend against a seeded sandbox, using the state DB as a locator and the `session-search`
skill for evidence. Pattern adapted from the
[session-grep eval harness](https://github.com/lhotwll217/session-grep).

A run measures **one subject**: `owner-operator` (default) or `naive-session-grep` — the
[#31](https://github.com/lhotwll217/owner-operator/issues/31) control that runs the same
`oo` binary at the same configured model (`.pi/settings.json`, falling back to the
committed `.pi/settings.example.json`) with `OO_EVAL_BASELINE_PROMPT` swapping out OO's
state/index composition. Mutation tools are removed from both; the agent factory is the
tool-roster source of truth; SSE transport is pinned and recorded in the manifest.

Scope: this eval grades answers, not SQL. Deterministic `query_database` correctness lives
in `src/state/query.test.ts`.

## Run

```sh
npm run eval:loop -- --help  # causal one-case → probe → core → holdout loop
npm run eval -- --label "<campaign>" --notes "<claim>"              # full suite, repeat 3
npm run eval -- --label "<campaign>" --notes "<claim>" --repeat 1   # smoke: one pass
npm run eval -- ... --subject naive-session-grep                    # run the #31 control instead
node eval/compare.mjs <global_results_A.json> <global_results_B.json> [--gate]
```

Comparison is downstream: point `compare.mjs` at any two published runs (harness vs its
last global entry, or harness vs the naive-session-grep control). Every stats entry
records `subject`, `repeat`, and `total_tests`, so smoke, full, and control runs stay
differentiated. Runs happen on dirty worktrees before the PR exists — once the durable
commit does, resolve the entry to it:

```sh
node eval/loop.mjs --backfill-git <eval_folder>   # uses current HEAD/branch; --commit/--branch override
```

Iteration policy lives in [`AUTORESEARCH.md`](AUTORESEARCH.md); campaign-specific claims
live under [`hypotheses/`](hypotheses/).

Needs: `oo`'s configured model backend — subjects and grader all run on it (copy
`.pi/settings.example.json` to the ignored `.pi/settings.json` only to customize it; it
also pins the subject's `defaultThinkingLevel`, recorded as `reasoning_level`). The grader
is a cheap pinned model at minimal reasoning (`openai-codex/gpt-5.4`; override with
`EVAL_GRADER_MODEL=provider/model` — it is not a subject). No API keys.

## PR comparison contract

The base branch carries earlier full-suite entries in `eval_stat_log.json` — one compact
single-subject summary per run (shape: `buildStatsEntry` in [`stats-log.mjs`](stats-log.mjs));
the raw `global_results.json` under the run's ignored result folder holds run-time git state
and per-case detail. Spend distributions cover calls, tokens, cost, and latency (the `oo`
subprocess wall-clock, `result.latencyMs` fallback). A full run that cannot publish exits
nonzero with the reasons. When posting a PR, backfill each run's entry to the commit that
carries its work (`--backfill-git`). Targeted runs stay in `history.jsonl` and cannot
publish; `compare.mjs` reports shared and unpaired cases separately when suites differ.

## Layout

| path | what |
| --- | --- |
| `fixtures/sessions.mjs` | synthetic sessions (claude + codex formats) — THE ground truth; cases key off facts planted here |
| `seed/build-fixture-home.mjs` | materializes a run-scoped `$TMPDIR/oo-eval-sandbox/<run-id>`: transcripts + seeded OO_HOME (sources config, state.db with versioned details history); timestamps relative to now; answer-key paths blacklisted |
| `providers/pi-agent-core.mjs` | shared runner: seeds once, spawns `oo`, records a hashed run manifest plus full session/tool trajectories and usage |
| `providers/oo-agent.mjs` | the owner-operator subject: OO's shipped read-only composition |
| `providers/naive-agent.mjs` | the naive-session-grep control: same runner/model/search capability without OO's state/index composition |
| `fixtures/naive-baseline-prompt.md` | the control subject's generic session-search prompt |
| `providers/codex-grader.mjs` | pinned cheap rubric grader (strict, verbosity-bias guarded; judge only, not a subject) |
| `cases.yaml` | every case, tagged by `qtype` + tool expectations; every subject attempts all of them |
| `asserts/tool-use.mjs` | soundness gate — evidence answers must read a transcript, not a summary (owner-operator subject, opt-in per case) |
| `asserts/efficiency.mjs` | tool-call / token / cost telemetry as named scores |
| `compare.mjs` | downstream: pairs two published runs per case; optional A≥B correctness gate; qtype breakdown |
| `loop.mjs` | attested one-case/probe/core/holdout runner; writes every run to history and per-run detail |
| `history.jsonl` | local append-only experiment ledger for targeted, probe, core, and full runs |
| `results/logs/<run>/global_results.json` | ignored full-run detail: metadata, pass rates, distributions, and per-case results |
| `eval_stat_log.json` | committed newest-first compact single-subject summaries of valid full runs; commit/branch resolve to the PR state via --backfill-git |
| `hypotheses/` | campaign-specific claims and expected trajectory changes |

## Mapping to promptfoo

- **Provider** — a [custom JS provider](https://www.promptfoo.dev/docs/providers/custom-api/) spawning the CLI, returning `{ output, tokenUsage, cost, metadata }` (`exec:` returns only stdout, no metadata).
- **Subjects** — two labeled providers over one `tests` set; a run filters to one with `--filter-providers`.
- **Correctness** — `llm-rubric` per case, graded by a pinned provider.
- **Tool behavior** — a `javascript` assertion over the provider's ordered `OO_TRACE`
  metadata ([docs](https://www.promptfoo.dev/docs/providers/custom-api/)): require a
  `session-search`, require a DB/state locator before it, reject direct transcript reads.
  Mutation tools are absent from every subject; the denylist is defense in depth.
- **Cross-run comparison** — no promptfoo native for this; emit `outputPath` JSON and post-process (`compare.mjs`).

Providers reseed the sandbox at load, so every run gets fresh activity windows. Manifests,
daemon logs, Pi sessions, and tool traces land in `results/logs/<run>/`. The publish gate
fails closed on missing grades, provider errors, count mismatches, or missing provenance; a
fatal model turn trips a run-wide circuit breaker so later cases fail cheaply.

## Reading results

- Spend deltas (tokens/tool calls/latency/cost) are attributable to the change under test
  only when the two compared runs share a model, grader, reasoning level, and repeat;
  `compare.mjs` prints a caveat when they don't.
- `handoff-needs-me-evidence` enforces "no evidence answers from summaries alone": passing
  requires transcript detail, not just the DB row.
- One variable per run: change the prompt OR a tool, re-run the subject, `compare.mjs`
  against the prior run.
