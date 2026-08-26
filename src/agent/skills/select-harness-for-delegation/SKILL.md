---
name: select-harness-for-delegation
description: Select and report an exact harness, model, and reasoning effort before an implicit delegated run.
---

# Select a harness for delegation

Use this workflow before `delegate_agent` unless the owner explicitly supplied all three parts of
the execution identity: harness, model, and effort. `effort: null` is an explicit effort. A complete
owner choice bypasses this workflow and passes through unchanged. Preserve every supplied harness,
model, and effort value—including `effort: null`—while selecting only omitted fields.

## Select

1. **Observe.** Call `get_harness_details` once with every plausible harness.
2. **Apply owner preferences.** Read `snapshot.preferences.content` as owner-controlled routing
   guidance. Match the task by meaning against standard and owner-added roles, or establish that no
   task preference applies.
3. **Fill omissions.** When no task preference applies, use that harness's owner-approved delegated
   baseline only for missing execution-identity fields. Call `manage_delegated_baseline` with
   `action: "propose"` to inspect its `approved` value; its unpinned candidate is only a proposal.
4. **Verify the candidate.** Use exact model IDs and reasoning values advertised by that harness.
   A current model whose reasoning choices are fully advertised needs no second observation;
   `effort: null` needs no separate selector. Otherwise inspect the exact candidate with
   `get_harness_details`. An inspection succeeds only when its confirmation exactly matches the
   harness, model, and nullable effort. Reject failed or mismatched inspections; choose an
   equal-or-higher-quality candidate with its required evidence, or ask the owner.
5. **Delegate.** Call `delegate_agent` with the selected harness, model, and effort. Keep the
   owner's task and working directory intact. The delegated-run lifecycle is the execution record;
   create no duplicate record and do not poll after launch.

## Constrained or rejected selections

Allowance pressure is pre-launch evidence, not merely a failure-recovery signal. When a current
allowance window is materially spent, consider another acceptable preference before launching.
Do not treat an unknown window as unused or constrained.

If `delegate_agent` rejects a choice for capacity, access, entitlement, an invalid harness/model
pairing, or availability—or a delivered run-completion reports that rejection—reapply the matching
preference and refresh `get_harness_details` after the rejection for both the rejected harness and every
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

When omitted identity fields require a default and `manage_delegated_baseline` reports no approved
baseline, **MUST NOT delegate yet**:

1. Present the actual unpinned ACP candidate returned by `action: "propose"`, including its exact
   harness, model, and effort. Do not invent or substitute a default. If discovery returned no
   candidate, ask the owner to choose.
2. Ask the owner to explicitly approve that exact candidate. Do not call `action: "approve"` based
   on silence, prior general preferences, or your own judgment.
3. After approval, call `manage_delegated_baseline` with `action: "approve"` and the exact accepted
   model and effort, including `effort: null` when that is the candidate.
4. Retry selection: refresh `get_harness_details` for the approved harness after approval, then
   call `delegate_agent` with the newly approved exact identity.

## Report

After launch, state the actual `harness / model / effort` returned by the launch lifecycle concisely;
do not report an intended identity as actual when the returned row differs. Say `effort null` when
null was selected. Explain a material departure from a matching preference, but do not claim the
preferences changed. Never silently lower required quality merely to make a launch succeed.
