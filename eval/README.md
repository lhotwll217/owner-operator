# Eval — Owner Operator vs the sessions-grep baseline

Proves [#31](https://github.com/lhotwll217/owner-operator/issues/31): the Operator's
prompt/tool composition answers session questions at ≥ baseline correctness, using the
state DB as a locator and the `session-search` skill for evidence. Pattern adapted from the
[session-grep eval harness](https://github.com/lhotwll217/session-grep).

## Controlled — same model, same framework, one variable

Both arms run the **same `oo` binary at the same configured model**
(`.pi/settings.json`, falling back to the committed `.pi/settings.example.json`) against the
same seeded sandbox, with mutation tools removed. The owner-operator arm uses the shipped
read-only composition; the baseline uses
the same runner and session-search capability but withholds OO's state/index composition through
`OO_EVAL_BASELINE_PROMPT`. The agent factory is the tool-roster source of truth.

So the tool-call / token / correctness deltas are attributable to OO's composition, not to
a model or harness difference. The harness pins SSE transport symmetrically for both arms so
long campaigns do not depend on WebSocket connection lifetime; the manifest records that pin.
A cross-model version was retired because it changed the harness and model at once.

## Run

```sh
npm run eval:loop -- --help  # causal one-case → probe → core → holdout loop
npm run eval -- --label "<campaign>" --notes "<claim>" --repeat 1  # ledgered full suite
npm run eval:compare   # paired report + correctness gate
```

Iteration policy lives in [`AUTORESEARCH.md`](AUTORESEARCH.md); campaign-specific claims
live under [`hypotheses/`](hypotheses/).

Needs: `oo`'s configured model backend for both arms (copy `.pi/settings.example.json` to the
ignored `.pi/settings.json` only to customize it), and Claude Code auth for the grader only
(any capable judge model works — it is not an arm). No API keys.

## PR comparison contract

The base branch carries earlier full-suite entries in `eval_stat_log.json`. Running the complete
suite writes a detailed `global_results.json` under that run's ignored result folder and prepends
a compact entry with branch, commit, eval folder, model/grader, repeat, pass rates, and distribution
statistics for calls, tokens, and cost. Dirty runs also retain a worktree content hash that includes
non-ignored untracked files. Distinct full runs on the same PR remain visible; rerunning
stats generation for the same eval folder refreshes that entry without duplicating it. Select the
accepted current-PR entry and the intended previous-PR entry by branch/commit for comparison.
Targeted development runs stay in `history.jsonl` and cannot publish here. When the suite changes,
compare shared case IDs from the raw results and report added/removed cases separately.

## One chain, not a DB suite

`query_database` is just one of OO's tools, so there is no separate DB eval. Both arms
attempt every case; the baseline has only grep, OO may shortcut through its state DB. The
`qtype` breakdown in `compare.mjs` is where the locator payoff shows: on the locate-led
cases (`state`, `stale`, `audit`, `handoff`) OO should reach parity with fewer tool calls.
Pure `query_database` correctness (does a SELECT return the right rows) is covered
deterministically and for free by `src/state/query.test.ts` — not re-tested through
an LLM run.

## Layout

| path | what |
| --- | --- |
| `fixtures/sessions.mjs` | synthetic sessions (claude + codex formats) — THE ground truth; cases key off facts planted here |
| `seed/build-fixture-home.mjs` | materializes a run-scoped `$TMPDIR/oo-eval-sandbox/<run-id>`: transcripts + seeded OO_HOME (sources config, state.db with versioned details history); timestamps relative to now; answer-key paths blacklisted |
| `providers/pi-agent-core.mjs` | shared runner: seeds once, spawns `oo`, records a hashed run manifest plus full session/tool trajectories and usage |
| `providers/oo-agent.mjs` | subject arm: OO's shipped read-only composition |
| `providers/naive-agent.mjs` | controlled ablation: same runner/model/search capability without OO's state/index composition |
| `fixtures/naive-baseline-prompt.md` | the control arm's generic session-search prompt |
| `providers/claude-grader.mjs` | pinned rubric grader (strict, verbosity-bias guarded; judge only, not an arm) |
| `cases.yaml` | every case, tagged by `qtype` + tool expectations; both arms attempt all of them |
| `asserts/tool-use.mjs` | soundness gate — evidence answers must read a transcript, not a summary (owner-operator arm, opt-in per case) |
| `asserts/efficiency.mjs` | tool-call / token / cost telemetry as named scores |
| `compare.mjs` | pairs arms per case; gate: OO correctness ≥ baseline; qtype breakdown for the locator payoff |
| `loop.mjs` | attested one-case/probe/core/holdout runner; writes every run to history and per-run detail |
| `history.jsonl` | local append-only experiment ledger for targeted, probe, core, and full runs |
| `results/logs/<run>/global_results.json` | ignored full-run detail: metadata, pass rates, distributions, and per-case results |
| `eval_stat_log.json` | committed newest-first compact summaries of valid complete full runs, with eval folder + Git identity |
| `hypotheses/` | campaign-specific claims and expected trajectory changes |

## How this maps to promptfoo's documented practice

Grounded in promptfoo's agent-eval docs, not improvised:

- **Provider** — a [custom JS provider](https://www.promptfoo.dev/docs/providers/custom-api/) that spawns the CLI and returns `{ output, tokenUsage, cost, metadata }`. (The simpler `exec:` provider returns stdout text only — no token/cost/metadata — so it can't carry our efficiency data.)
- **A/B** — two labeled providers over one `tests` set is promptfoo's native [matrix comparison](https://www.promptfoo.dev/docs/configuration/test-cases/).
- **Correctness** — native `llm-rubric` per case, graded by a pinned provider.
- **Tool behavior** — a `javascript` assertion over the provider's ordered `OO_TRACE`
  metadata ([custom-api docs](https://www.promptfoo.dev/docs/providers/custom-api/)). Cases
  can require a successful `session-search`, require a DB/state locator before it, and
  reject direct transcript reads. Mutation tools are structurally absent from both controlled
  arms; the assertion's mutation-name denylist is defense in depth, not a scored safety canary.
  Native OTLP trajectory assertions are not used
  because `oo`/pi does not emit OTLP spans.
- **Cross-arm ratio gate** — promptfoo has **no native** per-case arm pairing or ratio gate; the documented practice is to emit `outputPath` JSON and post-process. That's what `compare.mjs` is.

Providers reseed the sandbox at load, so every eval run gets fresh activity windows.
Manifests, daemon logs, complete Pi sessions, and tool traces land in
`results/logs/<run>/`; `eval:compare` fails closed on incomplete arms, provider/grader
errors, missing trajectories, stale artifacts, or correctness regressions. A fatal model turn
opens a run-wide circuit breaker so later cases fail cheaply instead of consuming judge tokens.

## Reading results

- Comparative spend (tokens/tool calls/cost) is the locator payoff, and since both arms
  run the same model it is attributable to OO's composition.
- The `handoff-needs-me-evidence` case is the "no evidence answers from summaries alone"
  criterion: passing requires transcript detail, not just the DB row.
- One variable per run: change the prompt OR a tool, reseed nothing else, re-run both
  configs, then `compare.mjs`.
