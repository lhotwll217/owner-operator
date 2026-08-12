---
name: select-harness-for-delegation
description: Select and report an exact harness, model, and reasoning effort before an implicit delegated run.
---

# Select a harness for delegation

Use this workflow before `delegate_agent` unless the owner explicitly supplied all three parts of
the execution identity: harness, model, and effort. `effort: null` is an explicit effort. A complete
owner choice bypasses this workflow and passes through unchanged. Preserve any partial owner choice
while selecting only the missing parts.

## Select

1. Read `~/.owner-operator/workspace/harness-roster.md`. It is owner-controlled guidance; never
   edit it. Treat its baseline role headings and any owner-added role headings uniformly. Classify
   the requested task by meaning, not by a fixed heading allowlist. A matching custom role can
   therefore extend the taxonomy without product changes.
2. Call `get_harness_details` for every harness that remains a plausible choice. Do this before
   launch even when the roster appears decisive. Use advertised model IDs only with the harness
   that advertised them, and use its supported effort values. Advertisement is evidence, not proof
   of account entitlement.
3. Select the exact harness, model, and effort that best follows the owner request and matching
   roster role while preserving the task's required quality. Consider current allowance facts when
   they exist. `null` in harness details means unknown, not empty, unavailable, unused, or zero;
   unknown account, catalog, entitlement, or allowance facts do not block an otherwise defensible
   selection.
4. If no task preference applies, use that harness's owner-approved delegated baseline. Call
   `manage_delegated_baseline` with `action: "propose"` to inspect its `approved` value; the
   unpinned ACP candidate returned alongside it is only a proposal and never replaces an approved
   baseline. Pass the approved model and nullable effort explicitly to `delegate_agent`.
5. Call `delegate_agent` once with the exact selected harness, model, and effort. Keep the owner's
   task and working directory intact. The existing delegated-run lifecycle is the execution record;
   do not create another record and do not poll after launch.

## Missing delegated baseline

When fallback is needed and `manage_delegated_baseline` reports no approved baseline:

1. Present the actual unpinned ACP candidate returned by `action: "propose"`, including its exact
   harness, model, and effort. Do not invent or substitute a default. If discovery returned no
   candidate, ask the owner to choose.
2. Ask the owner to explicitly approve that exact candidate. Do not call `action: "approve"` based
   on silence, prior general preferences, or your own judgment.
3. After approval, call `manage_delegated_baseline` with `action: "approve"` and the exact accepted
   model and effort, including `effort: null` when that is the candidate.
4. Retry selection, then call `delegate_agent` with the newly approved exact identity.

## Report

After launch, state the actual `harness / model / effort` concisely. Say `effort null` when null was
selected. Explain a material departure from a matching roster preference, but do not claim that the
roster changed. Launch rejection and constrained fallback policy belongs to the follow-up workflow;
never silently lower required quality merely to make a launch succeed.
