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
| `cases.yaml` | every case, tagged by `qtype` + tool expectations; both arms attempt all of them |
| `asserts/tool-use.mjs` | soundness gate — evidence answers must read a transcript, not a summary (owner-operator arm, opt-in per case) |
| `asserts/efficiency.mjs` | tool-call / token / cost telemetry as named scores |
| `compare.mjs` | pairs arms per case; gate: OO correctness ≥ baseline; qtype breakdown for the locator payoff |

## How this maps to promptfoo's documented practice

Grounded in promptfoo's agent-eval docs, not improvised:

- **Provider** — a [custom JS provider](https://www.promptfoo.dev/docs/providers/custom-api/) that spawns the CLI and returns `{ output, tokenUsage, cost, metadata }`. (The simpler `exec:` provider returns stdout text only — no token/cost/metadata — so it can't carry our efficiency data.)
- **A/B** — two labeled providers over one `tests` set is promptfoo's native [matrix comparison](https://www.promptfoo.dev/docs/configuration/test-cases/).
- **Correctness** — native `llm-rubric` per case, graded by a pinned provider.
- **Tool behavior** — a `javascript` assertion over the provider's `metadata` ([custom-api docs](https://www.promptfoo.dev/docs/providers/custom-api/); attested pattern: `ooneko/ai-agent-prompts`). We gate on exactly one behavior — the #31 soundness rule that evidence answers come from a transcript, not a summary row — and only on cases that opt in. Locator/efficiency choices are *observed* (per-qtype tool-call counts), never gated, so the neutral-prompt bet is measured, not enforced. The canonical alternative, [`trajectory:tool-used`](https://www.promptfoo.dev/docs/tracing/), needs the agent to emit **OTLP spans** — `oo`/pi don't, so that's the deferred upgrade path (it would add ordering/arg assertions). `tool-call-f1` is native but scores the *exact* tool set, which can't express "must include X, extras fine" — hence the metadata assert.
- **Cross-arm ratio gate** — promptfoo has **no native** per-case arm pairing or ratio gate; the documented practice is to emit `outputPath` JSON and post-process. That's what `compare.mjs` is.

Providers reseed the sandbox at load, so every eval run gets fresh activity windows.
Trajectories land in `results/logs/<run>/` for inspecting HOW each arm searched.

## Reading results

- Comparative spend (tokens/tool calls) is the locator payoff; cost is informational —
  the arms run different models by design (products as shipped).
- The `state-evidence-handoff` case is the "no evidence answers from summaries alone"
  criterion: passing requires transcript detail, not just the DB row.
- One variable per run: change the prompt OR a tool, reseed nothing else, re-run both
  configs, then `compare.mjs`.
