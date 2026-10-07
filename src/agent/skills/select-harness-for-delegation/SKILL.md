---
name: select-harness-for-delegation
description: Select and report an exact harness, model, and reasoning effort before an implicit delegated run.
---

# Select a harness for delegation

Use this workflow before `oo runs delegate` unless the owner explicitly supplied all three parts of
the execution identity: harness, model, and effort. `effort: null` is an explicit effort
(`--effort none`). A complete
owner choice bypasses this workflow and passes through unchanged. Preserve every supplied harness,
model, and effort value—including `effort: null`—while selecting only omitted fields.

## Continue existing work

To continue a cancelled or completed delegated run, use `oo runs resume`; its help owns
eligibility. Resume preserves the child conversation and its recorded harness, model, effort, and
cwd, so selection is unnecessary.

## Select

1. **Observe.** Run `oo harness details --harness <h> [--harness <h>…] --json` once with every
   plausible harness.
2. **Apply owner preferences.** Read `snapshot.preferences.content` as owner-controlled routing
   guidance. Match the task by meaning against standard and owner-added roles, or establish that no
   task preference applies.
3. **Fill omissions.** When no task preference applies, use that harness's owner-approved delegated
   baseline only for missing execution-identity fields. Run `oo harness propose <h> --json` to
   inspect its `approved` value; its unpinned candidate is only a proposal, and propose never saves.
4. **Verify the candidate.** Use exact model IDs and reasoning values advertised by that harness.
   A current model whose reasoning choices are fully advertised needs no second observation;
   `effort: null` needs no separate selector. Otherwise inspect the exact candidate with
   `oo harness details --inspect <h>:<model>:<effort|none> --json`. An inspection succeeds only when its confirmation exactly matches the
   harness, model, and nullable effort. Reject failed or mismatched inspections; choose an
   equal-or-higher-quality candidate with its required evidence, or ask the owner.
5. **Delegate.** Run `oo runs delegate --harness <h> --model <m> --effort <e> "<task>"` (or
   `--effort none`) with the selected identity. Keep the owner's task and working directory intact. The delegated-run lifecycle is the execution record;
   create no duplicate record and do not poll after launch.

## Constrained or rejected selections

Allowance pressure is pre-launch evidence, not merely a failure-recovery signal. When a current
allowance window is materially spent, consider another acceptable preference before launching.
Do not treat an unknown window as unused or constrained.

If `oo runs delegate` rejects a choice for capacity, access, entitlement, an invalid harness/model
pairing, or availability—or a delivered run-completion reports that rejection—reapply the matching
preference and refresh `oo harness details` after the rejection for both the rejected harness and every
replacement harness under consideration before retrying. Inspect a replacement when step 3
requires it. A stale advertisement can explain a rejection; never describe advertisement as
demonstrated access.

Retry automatically only with an exact harness/model/effort that preserves or improves the quality
required for the task. Cross-harness fallback is allowed on that basis. Never reduce the required
model capability or reasoning effort merely to obtain a successful launch. If the available
evidence does not support an acceptable replacement, ask the owner to choose and do not launch.

For an automatic retry, state all three facts in the transcript: the failed exact identity, the
replacement exact identity, and the material capacity/access/availability reason. The failed call
or existing delegated-run row remains the execution evidence. Do not edit the user harness
preferences, approved baseline, or any other durable preference, and do not create a failure ledger.
Before finishing that turn, verify the report literally identifies both triples as
`harness / model / effort`; a generic provider name or “the preferred model” is not the failed
exact identity.

## Missing delegated baseline

When omitted identity fields require a default and `oo harness propose` reports no approved
baseline, get the owner's approval for a baseline, then delegate:

1. Present the actual unpinned ACP candidate returned by `oo harness propose`, including its exact
   harness, model, and effort. Do not invent or substitute a default. If discovery returned no
   candidate, ask the owner to choose.
2. Ask the owner to explicitly approve that exact candidate. Do not run `oo harness approve` based
   on silence, prior general preferences, or your own judgment.
3. After approval, run `oo harness approve <h> --model <m> --effort <e>` with the exact accepted
   model and effort, using `--effort none` when the candidate's effort is null.
4. Retry selection: refresh `oo harness details` for the approved harness after approval, then
   run `oo runs delegate` with the newly approved exact identity.

## Report

After launch, state the actual `harness / model / effort` returned by the launch lifecycle concisely;
do not report an intended identity as actual when the returned row differs. Say `effort null` when
null was selected. Explain a material departure from a matching preference, but do not claim the
preferences changed. Never silently lower required quality merely to make a launch succeed.
