# Progressive disclosure for context finding

## Product outcome

Improve the headless user experience by locating the right session or widget row,
recovering the needed evidence, preserving chronology/provenance, and spending less context
on irrelevant candidates. A call-count instruction is not a tool improvement.

Primary research and prior art are captured in
[`docs/session-transcript-retrieval-research.md`](../../docs/session-transcript-retrieval-research.md).
Compact run outcomes stay in [`history.jsonl`](../history.jsonl). Raw trajectory-linked findings
stay local in the ignored `findings.jsonl`; accepted, sanitized conclusions are recorded here.

## Hypothesis

Context finding should expose progressively larger, stable apertures:

1. **Locate cheaply.** Filter current widget state or use the SQL index when identity is
   state-backed. For unknown transcript text, rarity-ranked `--any` returns candidate IDs
   and term statistics.
2. **Inspect or search one candidate.** `--skim ID` returns a complete short conversation or
   a sampled spine. For a long or already-known session, `--query TEXT --session ID` locates
   evidence inside that transcript without reopening global discovery.
3. **Drill into evidence.** Query hits expose `id` + `idx`; `--session ID --at IDX` allocates
   the output budget around that message.

Each layer must return a stable pointer into the next. When a trajectory flails, classify
whether the locator was missing, ranking feedback was hidden, the next aperture discarded
evidence, or a broad tool result forced the model to infer a filter the product already
knows. Fix that boundary before adding strategy prose.

## Evaluation seam

The QA subject is always the shipped headless harness (`./oo "question"`): model, Owner
Operator prompt, state/DB tools, session-search skill and wrapper, and the vendored retrieval
primitive together. Direct `session-grep` invocations are useful deterministic mechanism
probes, but they are not end-to-end product evidence and should not replace a headless run.

Use failed headless trajectories to decide where a fix belongs:

- Client-agnostic retrieval mechanics—ranking feedback, canonical pointers, candidate
  grouping, output apertures, and semantic exclusion primitives—belong upstream in
  `session-grep` so any naive harness benefits.
- Product policy—which locator to choose, when to exclude the caller, how Owner Operator's
  own history is scoped, and what widget state means—belongs in the Owner Operator harness.

After a raw mechanism proof, accept the change only when a fresh headless trajectory uses
the improved surface to recover the right evidence. Preserve that trajectory as the finding.

### Cold headless QA hygiene

The QA prompt is itself searchable data. Do not publish the exact runtime question in a
different indexed coding session before the run: immediate-caller exclusion cannot remove
copies in an ancestor/planning session. Either generate the final paraphrase only inside the
excluded caller, or freeze the searchable corpus/cutoff before authoring prompts. Record the
caller ID and corpus cutoff with the trajectory, and treat prompt-copy ranking as evaluator
contamination rather than product evidence.

## Accepted representation

- **Locate:** authoritative widget-state filters and the SQL index return stable session IDs;
  caller provenance excludes prompt echoes from discovery, while Owner Operator history remains
  an explicit scope.
- **Discover:** rarity-ranked search and grouped candidates expose matched terms, omission
  feedback, and stable message pointers before spending a larger context aperture.
- **Inspect:** short conversations are lossless within budget; sampled skims and scoped in-session
  queries preserve the selected session boundary for larger histories.
- **Drill:** anchored windows spend a hard rendered-output budget around the selected message.
- **Evidence boundary:** widget/database rows identify candidates but never substitute for
  transcript evidence when exact detail or proof is requested.

Diverse intra-session candidate spans and branch/replay deduplication remain separate, unaccepted
hypotheses. They should earn new evaluation only if the failure recurs.

## Accepted campaign result

The `post-fix full 3x final` campaign passed all gates across fourteen cases and three repeats.
Owner Operator retained correctness on every case while the state evidence boundary repaired the
duplicate-topic regression without prompt coaching. The harness pins SSE symmetrically for both
arms after an earlier `auto` WebSocket run was correctly invalidated and circuit-broken. Compact
run hypotheses and artifact pointers remain in [`history.jsonl`](../history.jsonl). Global
aggregates and PR provenance are single-sourced in
[`eval_stat_log.json`](../eval_stat_log.json); the final accepted/rejected findings are summarized
in [`discovery-mode-classification.md`](discovery-mode-classification.md).

Use the ladder in [`AUTORESEARCH.md`](../AUTORESEARCH.md). Do not advance a mechanism past a
failed rung, and do not treat fewer calls as a win when correctness or evidence regresses.
