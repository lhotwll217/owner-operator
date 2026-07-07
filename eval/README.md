# Eval — Owner Operator vs the sessions-grep baseline

Proves [#31](https://github.com/lhotwll217/owner-operator/issues/31): the Operator's
prompt/tool composition answers session questions at ≥ baseline correctness, using the
state DB as a locator and `search_sessions` for evidence. Pattern adapted from the
[session-grep eval harness](https://github.com/lhotwll217/session-grep).

## Run

```sh
npm run eval           # both arms over every case (promptfoo)
npm run eval:compare   # paired report + correctness gate
```

Cheap first pass — drop the paid arms to haiku (the OO arm's model is fixed by
`.pi/settings.json`):

```sh
EVAL_MODEL=claude-haiku-4-5-20251001 EVAL_GRADER_MODEL=haiku npm run eval
```

Needs: Claude Code auth (baseline arm + grader run `claude -p`), and `oo`'s configured
model backend (`.pi/settings.json`). No API keys.

## One chain, not a DB suite

`query_database` is just one of OO's tools, so there is no separate DB eval. Both arms
attempt every case; the baseline greps the transcripts, OO may shortcut through its state
DB. The `qtype` breakdown in `compare.mjs` is where the locator payoff shows: on the
locate-led cases (`state`, `stale`, `audit`, `handoff`) OO should reach parity with fewer
tool calls. Pure `query_database` correctness (does a SELECT return the right rows) is
covered deterministically and for free by `src/gateway/query-db.test.ts` — not re-tested
through a paid LLM run.

## Layout

| path | what |
| --- | --- |
| `fixtures/sessions.mjs` | synthetic sessions (claude + codex formats) — THE ground truth; cases key off facts planted here |
| `seed/build-fixture-home.mjs` | materializes `$TMPDIR/oo-eval-sandbox`: transcripts + seeded OO_HOME (sources config, threads.db with versioned triage history); timestamps relative to now |
| `providers/oo-agent.mjs` | subject: `oo "question"` against the sandbox home; tool calls + usage parsed from `OO_TRACE` NDJSON |
| `providers/baseline-agent.mjs` | control: `claude -p` + vendored session-grep over the same transcripts |
| `providers/claude-grader.mjs` | pinned rubric grader (strict, verbosity-bias guarded) |
| `cases.yaml` | every case, tagged by `qtype`; both arms attempt all of them |
| `compare.mjs` | pairs arms per case; gate: OO correctness ≥ baseline; qtype breakdown for the locator payoff |

Providers reseed the sandbox at load, so every eval run gets fresh activity windows.
Trajectories land in `results/logs/<run>/` for inspecting HOW each arm searched.

## Reading results

- Comparative spend (tokens/tool calls) is the locator payoff; cost is informational —
  the arms run different models by design (products as shipped).
- The `state-evidence-handoff` case is the "no evidence answers from summaries alone"
  criterion: passing requires transcript detail, not just the DB row.
- One variable per run: change the prompt OR a tool, reseed nothing else, re-run both
  configs, then `compare.mjs`.
