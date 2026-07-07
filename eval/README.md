# Eval — Owner Operator vs the sessions-grep baseline

Proves [#31](https://github.com/lhotwll217/owner-operator/issues/31): the Operator's
prompt/tool composition answers session questions at ≥ baseline correctness, using the
state DB as a locator and `search_sessions` for evidence. Pattern adapted from the
[session-grep eval harness](https://github.com/lhotwll217/session-grep).

## Run

```sh
npx promptfoo eval -c eval/promptfooconfig.yaml      # comparative: OO vs baseline
npx promptfoo eval -c eval/promptfooconfig-oo.yaml   # OO-only: DB-dependent cases
node eval/compare.mjs                                # paired report + gates
```

Needs: Claude Code auth (baseline arm + grader run `claude -p`), and `oo`'s configured
model backend (`.pi/settings.json`). No API keys.

## Layout

| path | what |
| --- | --- |
| `fixtures/sessions.mjs` | synthetic sessions (claude + codex formats) — THE ground truth; cases key off facts planted here |
| `seed/build-fixture-home.mjs` | materializes `$TMPDIR/oo-eval-sandbox`: transcripts + seeded OO_HOME (sources config, threads.db with versioned triage history); timestamps relative to now |
| `providers/oo-agent.mjs` | subject: `oo "question"` against the sandbox home; tool calls + usage parsed from `OO_TRACE` NDJSON |
| `providers/baseline-agent.mjs` | control: `claude -p` + vendored session-grep over the same transcripts |
| `providers/claude-grader.mjs` | pinned rubric grader (strict, verbosity-bias guarded) |
| `cases-compare.yaml` | evidence/locator/summary/negative — both arms |
| `cases-oo.yaml` | state/audit/stale/handoff — need the DB; gate OO absolutely |
| `compare.mjs` | pairs arms per case; gates: OO ≥ baseline on comparative, 100% on OO-only |

Providers reseed the sandbox at load, so every eval run gets fresh activity windows.
Trajectories land in `results/logs/<run>/` for inspecting HOW each arm searched.

## Reading results

- Comparative spend (tokens/tool calls) is the locator payoff; cost is informational —
  the arms run different models by design (products as shipped).
- The `state-evidence-handoff` case is the "no evidence answers from summaries alone"
  criterion: passing requires transcript detail, not just the DB row.
- One variable per run: change the prompt OR a tool, reseed nothing else, re-run both
  configs, then `compare.mjs`.
