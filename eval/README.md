# Eval — Owner Operator vs the sessions-grep baseline

Proves [#31](https://github.com/lhotwll217/owner-operator/issues/31): the Operator's
prompt/tool composition answers session questions at ≥ baseline correctness, using the
state DB as a locator and `search_sessions` for evidence. Pattern adapted from the
[session-grep eval harness](https://github.com/lhotwll217/session-grep).

## Controlled — same model, same framework, one variable

Both arms run the **same `oo` binary at the same model** (`.pi/settings.json`, codex
gpt-5.5) against the same seeded sandbox. They differ by exactly one thing — OO's
composition:

- **owner-operator** — OO's prompt + full toolset (`query_database`,
  `get_current_session_state`, `search_sessions`, …).
- **baseline** — a generic session-search prompt + `search_sessions` (the same grep engine
  OO wraps) and `read`, but **no DB/state tools**, via `OO_EVAL_BASELINE_PROMPT` (see
  `providers/naive-agent.mjs`). Both arms hold `read`, so the single variable is OO's
  DB tools + prompt.

So the tool-call / token / correctness deltas are attributable to OO's composition, not to
a model or harness difference. A cross-model version (OO/gpt-5.5 vs Claude Code/haiku) was
retired as unscientific — and is unrunnable anyway: pi has no Anthropic auth and `claude -p`
can't run gpt-5.5, so there's no shared model between two different harnesses.

## Run

```sh
npm run eval           # both arms over every case (promptfoo)
npm run eval:compare   # paired report + correctness gate
```

Needs: `oo`'s configured model backend (`.pi/settings.json`) for both arms, and Claude Code
auth for the grader only (any capable judge model works — it is not an arm). No API keys.

## One chain, not a DB suite

`query_database` is just one of OO's tools, so there is no separate DB eval. Both arms
attempt every case; the baseline has only grep, OO may shortcut through its state DB. The
`qtype` breakdown in `compare.mjs` is where the locator payoff shows: on the locate-led
cases (`state`, `stale`, `audit`, `handoff`) OO should reach parity with fewer tool calls.
Pure `query_database` correctness (does a SELECT return the right rows) is covered
deterministically and for free by `src/gateway/query-db.test.ts` — not re-tested through
an LLM run.

## Layout

| path | what |
| --- | --- |
| `fixtures/sessions.mjs` | synthetic sessions (claude + codex formats) — THE ground truth; cases key off facts planted here |
| `seed/build-fixture-home.mjs` | materializes `$TMPDIR/oo-eval-sandbox`: transcripts + seeded OO_HOME (sources config, threads.db with versioned details history); timestamps relative to now |
| `providers/pi-agent-core.mjs` | shared runner: seeds the sandbox once, spawns `oo`, parses `OO_TRACE` NDJSON into tool calls + usage |
| `providers/oo-agent.mjs` | subject arm: OO as shipped (full prompt + toolset) |
| `providers/naive-agent.mjs` | control arm: same `oo`/model, generic prompt + `search_sessions`/`read`, no DB tools (`OO_EVAL_BASELINE_PROMPT`) |
| `fixtures/naive-baseline-prompt.md` | the control arm's generic session-search prompt |
| `providers/claude-grader.mjs` | pinned rubric grader (strict, verbosity-bias guarded; judge only, not an arm) |
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

- Comparative spend (tokens/tool calls/cost) is the locator payoff, and since both arms
  run the same model it is attributable to OO's composition.
- The `handoff-needs-me-evidence` case is the "no evidence answers from summaries alone"
  criterion: passing requires transcript detail, not just the DB row.
- One variable per run: change the prompt OR a tool, reseed nothing else, re-run both
  configs, then `compare.mjs`.
