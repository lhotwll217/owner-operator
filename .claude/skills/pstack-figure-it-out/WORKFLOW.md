Read [pstack portability and capability checks](../pstack/README.md) before following this workflow. Owner and harness policy governs every step.

# Figure it out

When the task matches no playbook, design one. The deliverable before any code is the workflow itself: a sequence of phases that scales rigor to the task, runs the scientific method, and leaves a decision trail a human can audit after stepping away. Bias toward more rigor. The cost of building the wrong thing dwarfs the cost of being careful.

## Start

Open a todolist whose first item is to read the Principles section of the [pstack-poteto-mode](../pstack-poteto-mode/WORKFLOW.md) skill. Then add the phases below as todos.

## Phase A: Frame

Ground first, then commit. Don't start the run until you can state:

- The definition of done as a falsifiable predicate (the [pstack-principle-prove-it-works](../pstack-principle-prove-it-works/WORKFLOW.md) principle skill).
- Scope, quantified: rough units and effort, plus the blockers grounding surfaced.
- The rigor level, biased high. One-way doors and high blast radius get more. Reversible low-stakes steps get less. Rigor is gates and artifacts, not "try harder".

Present the framing and tradeoffs before committing to a long run. Reversible work proceeds (the [pstack-principle-never-block-on-the-human](../pstack-principle-never-block-on-the-human/WORKFLOW.md) principle skill), but a multi-hour run earns one checkpoint.

## Phase B: Design the workflow

Decompose into atomic, independently-landable units. Sequence riskiest-unknown-first. Scaffold and verification come before features (the [pstack-principle-foundational-thinking](../pstack-principle-foundational-thinking/WORKFLOW.md) principle skill).

- Build the verification harness before the work, with the baseline captured from the pre-change state, so the check reads as "old value vs new value".
- For one-way-door design decisions, run the [pstack-architect](../pstack-architect/WORKFLOW.md) skill (it runs [pstack-arena](../pstack-arena/WORKFLOW.md)). Skip it for mechanical work whose shape is already concrete. A second arena over a settled design is over-engineering (the [pstack-principle-laziness-protocol](../pstack-principle-laziness-protocol/WORKFLOW.md) principle skill).
- Decide what fans out. Parallelize only across seams, and give each worker its own worktree or branch (the [pstack-principle-separate-before-serializing-shared-state](../pstack-principle-separate-before-serializing-shared-state/WORKFLOW.md) principle skill). Don't over-fan.
- Write the designed phase list down. That list is what the human reviews.

Then execute the design. Add its steps to the todolist as concrete items, after the Phase C entry and before Phase D. Run each under the Phase C loop discipline, and weave the Phase D log through them, a row as each step lands, rather than saving the whole trail for the end.

## Phase C: Run the loop

Each unit is an experiment. State the hypothesis, make the smallest change, measure against the predicate on the real artifact, keep it if it advanced, revert it if it didn't.
Apply the [pstack-principle-sequence-verifiable-units](../pstack-principle-sequence-verifiable-units/WORKFLOW.md) principle skill, verifying each unit before starting the next instead of batching checks at the end.

- Verify by inspecting the artifact, never a self-report. When something passes too easily, suspect the observation method before the system.
- Pair delegated work with a judge and audit the delegates' artifacts yourself before trusting them. If a worker games the gate, reset and harden the contract. If the gate itself is wrong, fix the gate in its own change rather than routing around it.
- A verdict is VERIFIED, NOT VERIFIED, or INCONCLUSIVE. Inconclusive is not a pass. Don't hide a negative.

## Phase D: Keep the audit trail

Log the run via the [pstack-show-me-your-work](../pstack-show-me-your-work/WORKFLOW.md) skill, one canonical TSV with a row per decision and per unit, evidence as links. figure-it-out's work is usually ambitious enough to commit the trail so the reviewer can read it in the PR. Commit it when confidence has to be shown. Prefer evidence produced by committed scripts. The trail plus the diff is what lets the human come back and trust the work.

## Phase E: Verify and hand back

Check the whole against the Phase A predicate on the real product, not just the harness. Encode any recurring correction as a gate, a lint rule, a check, or a script (the [pstack-principle-encode-lessons-in-structure](../pstack-principle-encode-lessons-in-structure/WORKFLOW.md) principle skill).

**Reply:** the playbook you designed, the rigor level and why, the decision-trail path, what's verified against the predicate, and what's still open.
