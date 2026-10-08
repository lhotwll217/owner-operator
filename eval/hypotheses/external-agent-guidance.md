# External coding agents and the help-tree guidance change

Claim under test: moving command guidance out of the outside-agent skill and into `oo … --help`
([#181](https://github.com/lhotwll217/owner-operator/issues/181),
[#187](https://github.com/lhotwll217/owner-operator/pull/187)) leaves an outside agent able to
reach the same answers through the same routes. The subject is an external coding agent holding
only the measured checkout's `skills/owner-operator/SKILL.md` and its `oo` CLI.

Subjects, fixture, isolation, and validity rules live in
[Agent evaluations](../../docs/evals.md#external-coding-agents). This file holds the campaign:
what is covered, what is not, and what the runs showed.

## Case applicability

`metadata.subjects` in [`cases.yaml`](../cases.yaml) is the declaration; this is why each one reads
the way it does.

| cases | external subjects | why |
| --- | --- | --- |
| 16 retrieval | run | a session question is answerable through `oo` and transcripts |
| 2 mark-done | excluded | the sample delivers a child's completion into the parent Operator session and waits for that session's turn to end ([`run-scenario-trial.ts`](../behavioral/run-scenario-trial.ts)); an external caller has no such session |
| 10 delegation-selection | excluded | the sample grades the harness-selection policy, which lives in `src/prompts/owner-operator.md` and its `select-harness-for-delegation` skill; `oo harness` help carries none of it, so the subject is never handed the policy under test |
| 4 external-only | run | each needs a caller identity to exclude, a fixture only the external trial materializes, or guidance an outside agent reads from help |

The two excluded families also grade the in-process Pi trajectory attestations in
[`contract.mjs`](../behavioral/contract.mjs), which an external harness does not produce.

## Guidance surfaces

Every block #187 moved, and what exercises it for an external agent.

| surface | where it moved | covered by |
| --- | --- | --- |
| index before transcripts | skill kept one line; the full discovery policy entered root help | `handoff-needs-me-evidence`, `duplicate-topic-disambiguation`, and the rest of the retrieval suite |
| caller identity `--from-session` | skill section to root help | `external-error-provenance`, plus the caller-identity rule on every external case |
| noun and verb help routing | skill "Operations" became "Start at `oo --help`" | every case |
| `oo db` tables and describe before SQL | new in `db` help | the retrieval cases that query the index |
| `session-state list` authority | Operator prompt to `session-state` help | `state-what-needs-me`, `external-current-obligations` |
| delegate background, detach, reattach | **skill paragraph deleted**, now `runs` and `runs delegate` help | `runs-background-detach` |
| resume eligibility | **skill paragraph deleted**, now `runs resume` help | `runs-resume-eligibility` |
| `session-state done` | Operator prompt to `done` help | not covered: marking a session done is the Operator's job, and the mark-done cases stay with the behavioral subject |
| `schedules` | Operator prompt to `schedules` help | not covered: the outside-agent skill never routed to schedules |

The two deleted paragraphs are the change's largest exposure for an outside agent, and the two
cases named against them were written for this campaign.

## Results

Codex CLI 0.160.0, `gpt-6-astra` at medium effort, grader `gpt-5.6-luna` at high reasoning, 20
cases at repeat 3 per checkout, 120 live samples. Both measurements valid.

| case | main `5bd55b6` | #187 `1cba061` |
| --- | --- | --- |
| state-what-needs-me | 0/3 | 3/3 |
| external-current-obligations | 0/3 | 3/3 |
| summary-units-session | 3/3 answers, 2/3 evidence | 3/3 answers, 3/3 evidence |
| stale-abandoned | 0/3 | 0/3 |
| the other 16 | 3/3 | 3/3 |

Answers: 17 of 20 cases clean on main, 19 of 20 on #187. `compare.mjs --gate` passes, which is an
aggregate check; the per-case accounting above is the one that carries the claim.

Both improvements are the same behavior, which rows count as a current obligation. On main the
agent answered "three reviews need your attention" and listed two idle threads beside the real one.
On #187 it answered "One thing needs you: review PR #42 … No other sessions are currently marked as
needing you." `summary-units-session` is the discovery policy working: main answered "where does
the work stand" from `oo db query` rows and never opened a transcript, while #187 took the returned
id to `oo search --skim`.

`stale-abandoned` fails on both arms for the same reason, neither names the lumen-notes
storage-migration thread, so it is pre-existing rather than a #187 effect.

Spend per case, main to #187: 7.50 to 7.68 `oo` calls, 83.4k to 91.3k tokens, 37.4s to 43.0s.
Nearly all of it is the two guidance cases, where main needed no `oo` call because the text was in
the skill and #187 spends about 4.7 calls reading help to reach the same answer.

## Instrument corrections during the campaign

Each was found by review of the harness rather than by a failing case, and each is fixed with a
test that fails without the fix.

- The external trial reduced the harness trajectory to a count, so the gate saw only `oo` calls. A
  case forbidding a surface passed while the agent ran arbitrary shell, and a transcript read
  through the harness's own file tool never reached the direct-read rule. The trial now reports
  every tool-ish SDK item, and the gate reads the whole trajectory for forbidden surfaces and
  direct reads while the launcher's recorded argv drives the CLI-surface and ordering rules.
- One `oo` word in a compound command shielded the rest of it from the direct-read rule.
- `expectSessionSearchSince` compared the `--since` value as a string, so an agent that computed
  the dates for the requested window failed a rule its search satisfied. Regrading the saved argv
  evidence turns that rule from 0/3 to 3/3 on both arms, so the agents had scoped correctly all
  along.
- The trial worker was signalled alone, which left a stubborn agent running and holding the
  inherited stdout pipe so it never closed. The worker now leads its own process group, every
  ending clears that group, a leftover descendant invalidates the sample, and an interrupt
  escalates on its own clock.

The answer comparison is independent of all four: `llm-rubric` grades the subject's output, which
no gate change touches.

## Limits

- `external-claude-code` has no live run. This machine's Claude Code login is keychain-backed, and
  from an isolated `CLAUDE_CONFIG_DIR` the CLI reports `Not logged in`; with a `.credentials.json`
  present it reads that file instead and attempts a refresh, which is the path the sandbox already
  copies to. The supported alternatives are `ANTHROPIC_API_KEY` or `apiKeyHelper` through
  `--settings`. All three need a credential the owner supplies, so the subject is wired and
  controlled-tested but its coverage is scoped out rather than claimed.
- Three synthetic cases per guidance surface at one model is a focused check, not a representative
  workload.
- An outside agent that places `--from-session` before the noun gets exit 2 on both arms, and the
  error names `--json` rather than the misplaced flag, so it spends a call before recovering. This
  is pre-existing product behavior and is not addressed here.
