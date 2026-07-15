# Interaction-history retrospectives

## Status

Active regression campaign for [issue #62](https://github.com/lhotwll217/owner-operator/issues/62).
Do not publish a new baseline from a targeted run.

## Finding and hypothesis

The runtime prompt names transcript search and the skill documents Owner Operator's separate
namespace, but neither classifies “our interactions,” recurring feedback, or behavior-over-time
retrospectives as history questions. Current-chat feedback can therefore become an unsupported
substitute for saved interactions.

A compact classification rule in the runtime prompt should make these questions search
`--owner-operator` before answering, while preserving explicit current-turn-only requests. The
answer should retain the searched time and namespace scope and separate repeated cross-session
evidence from one-offs.

## Evaluation seam

Both cases are train/core regressions because they represent the known issue's positive and
current-turn-only boundaries rather than untouched holdouts. Four saved Owner Operator sessions
contain two instances of recurring outcome-first feedback, one one-off table preference, and a similar
20-day-old request outside the seven-day scope; the current eval turn supplies contradictory
feedback. The trajectory must preserve the time window while using session-search with the Owner
Operator namespace, and the answer rubric requires cross-session recurrence, the one-off, and the
observed behavior change. `owner-operator-current-turn-only` protects the inverse route: an
explicitly current-turn question must answer from the turn without transcript search.

Acceptance requires both focused cases to pass correctness and trajectory gates, plus the
deterministic fixture and trajectory-assertion tests. Existing baselines remain unchanged.

## Verification

The focused current-turn boundary passed correctness and trajectory without transcript tools in
`2026-07-15T08-44-56-667Z`. The retrospective passed correctness and the real traced Bash-command
trajectory in `2026-07-15T08-48-19-032Z`: it searched the Owner Operator namespace with `--since 7d`,
separated recurring and one-off feedback, and excluded the 20-day decoy. Earlier targeted runs remain
in `eval/history.jsonl`; they exposed and led to fixes for the trace assertion's synthetic argument
shape and an under-specified fixture discovery anchor. No baseline or full-run stats were published.
