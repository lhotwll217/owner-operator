### Feature

**You own the design. Plan, review, verify.** Delegate implementation. Stay in the lead.

1. [pstack-how](../../pstack-how/WORKFLOW.md) over the affected subsystem.
2. [pstack-architect](../../pstack-architect/WORKFLOW.md) for parallel design exploration. Skipping stays as `architect skipped: <reason>`. Do not fold the design decision silently into implementation.
3. Write the throughput checkpoint as four todo items. A dimension that genuinely does not apply (single file, no fan-out) keeps its item with `n/a: <reason>` rather than being dropped:
   - **Blocking first steps.** Gates run before fan-out.
   - **Independent workstreams.** Disjoint files, services, or layers parallelize. Shared writes serialize.
   - **Shared mutable state.** Default to splitting the target (the [pstack-principle-separate-before-serializing-shared-state](../../pstack-principle-separate-before-serializing-shared-state/WORKFLOW.md) principle skill). Serialize only for real invariants.
   - **Smallest safe decomposition.** If one worker is best, name why.
4. Delegate code-writing to a subagent using your configured feature model (selected through owner policy) with a specific scope (file paths, named data shape and its organizing structure per [pstack-principle-model-the-domain](../../pstack-principle-model-the-domain/WORKFLOW.md), a state machine over scattered booleans, a table/registry over branching, a typed model over repeated shape assumptions, chosen before the delegate writes logic, and success criteria). Review its diff yourself. When the implementation admits multiple valid shapes (error handling, abstraction layer, test structure), delegate via the [pstack-arena](../../pstack-arena/WORKFLOW.md) skill instead so the runners surface the alternatives and the cross-judge guards the pick. Owner delegation policy takes precedence. When nesting is forbidden or delegation unavailable, complete the implementation directly, review the diff against the contract, and disclose the missing independent review. Comments per **Comments**. Surgical edits, re-ground against the source for upstream-derived files. Port shared-primitive improvements to all consumers and verify each. Commit liberally.
5. Verify on the matching surface. "Inconclusive" or wrong-surface is not a pass. Flag it.
6. Rebase into small, ordered commits. Stack follow-ups.
   Use the [pstack-principle-sequence-verifiable-units](../../pstack-principle-sequence-verifiable-units/WORKFLOW.md) principle skill, building, verifying, and committing each small unit before the next.
7. If the design is contested, [pstack-interrogate](../../pstack-interrogate/WORKFLOW.md) before shipping.
8. Run **Opening a PR**.

Code-coupled work (one feature, one migration) goes to a single owner with the checkpoint inline. That owner fans out internally after the blocking phase. Parent-level fan-out is for slices that produce independent artifacts (audits, cross-subsystem investigations, competing experiments). Rewrite the checkpoint at phase boundaries. Spawn a fresh owner rather than chaining interrupts.

**Reply:** what you built, what you chose and why, the throughput checkpoint, open decisions. Tables for design alternatives.
