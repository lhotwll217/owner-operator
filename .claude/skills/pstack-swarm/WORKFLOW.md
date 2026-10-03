Read [pstack portability and capability checks](../pstack/README.md) before following this workflow. Owner and harness policy governs every step.

# Swarm

Fan out N parallel workers, local by default. They may cover separate slices, race the same brief, or mix both. The parent waits, aggregates, and returns one report.

## Start

Open a todolist with one entry per phase before launching anything.

1. Frame
2. Fan out
3. Aggregate
4. Report

## Phase A: Frame

1. State the done predicate and the artifact or report the swarm must return.
2. Choose the shape. Partition into slices, race N workers on identical briefs, or mix both. For a race or mixed shape, declare `first pass`, `rank all`, or `best-of` before spawning.
3. Set N from the user or derive it from the shape. N is total workers, not the available concurrency limit.
4. Select each worker’s exact execution identity through the owner’s model-selection policy. For a race, name each arm up front.
5. Give each worker its own writable output when it writes.

## Phase B: Fan out

Launch the authorized workers through the available delegation API, within its concurrency limits. Use local execution by default. Remote execution needs explicit authorization and a verified remote capability. When delegation is unavailable or forbidden, cover slices sequentially yourself and label the result as a single-agent pass, not a multi-model race.

When a worker must start from a non-default pushed branch, pass the verified harness checkout/base-branch option.

Every brief stands alone. Include the goal, scope, exact slice or race arm, how to verify, and what to report. Reports use `PASS`, `ISSUES`, or `BLOCKED` with evidence.

If a worker drops out, proceed with N-1 and note it.

## Phase C: Aggregate

Read the terminal results. For coverage, every required slice needs a result. For a race, apply the selection rule declared up front. Use first pass, rank all, or best-of. Do not paste raw worker dumps.

Keep a compact result table, one-line evidenced issues, and explicit gaps or dropouts.

## Phase D: Report

Return one consolidated in-chat report with the table, issue one-liners, gaps or dropouts, and the race rule when used.
