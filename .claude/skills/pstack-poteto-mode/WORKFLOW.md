Read [pstack portability and capability checks](../pstack/README.md) before following this workflow. Owner and harness policy governs every step.

# Poteto mode

## Non-negotiables

The Principles section below grounds every trigger. In your reply, name each principle that shaped a decision and the specific choice it changed. Cite only principles whose linked WORKFLOW.md you read this session.

Remaining triggers:

- Nontrivial change, architecture decision, or "are we sure?" → the [pstack-how](../pstack-how/WORKFLOW.md) skill.
- About to use the harness question tool (or a plain question if unavailable) on a "which approach", "how should I", or "what should this do" fork → classify it before you ask. If the answer is a fact you could observe by running something (behavior, timing, layout, output, perf, even whether an eval separates), it is not the human's to answer. Sketch it via the Prototype playbook (`playbooks/prototype.md`) and let the result decide. If the task is a read-only Investigation whose deliverable is a cited answer, stay in it and answer from the evidence rather than building a sketch. Reserve the question for a genuine product or preference call no experiment can settle.
- Any code → name the data shape first, and choose its organizing structure per [pstack-principle-model-the-domain](../pstack-principle-model-the-domain/WORKFLOW.md).
- Code crossing a function boundary → the [pstack-architect](../pstack-architect/WORKFLOW.md) skill, parallel design exploration before implementing.
- Parallel fan-out → the [pstack-swarm](../pstack-swarm/WORKFLOW.md) skill for coverage matrices, races, gauntlets, and exploration partitions. Use [pstack-arena](../pstack-arena/WORKFLOW.md) for design or code bakeoffs with base selection and grafting.
- Contested design → the [pstack-interrogate](../pstack-interrogate/WORKFLOW.md) skill (multi-model adversarial) before shipping.
- Nontrivial multi-step → write the throughput checkpoint (Feature step 3).
- Any prose surface → the [pstack-unslop](../pstack-unslop/WORKFLOW.md) skill. Your reply is a prose surface. Write it per **Writing the reply**. Agent-facing prose also follows the skill-authoring guidance in the portability entry point.
- Docs, RFCs, readmes, PR descriptions, or commit messages → the [pstack-technical-writing](../pstack-technical-writing/WORKFLOW.md) skill (`/pstack-technical-writing`).
- Before commit → the deslop capability or manual substitute resolved in the portability entry point.
- Before review → the [pstack-no-comments](../pstack-no-comments/WORKFLOW.md) skill (`/pstack-no-comments`).
- Shipping UI / IDE / CLI → the matching control skill. `cursor-team-kit` publishes `control-cli` (CLIs and TUIs) and `control-ui` (browser / Electron / web UIs). For bug fixes, reproduce first on the same surface yourself. Hand to the user only under the narrow Bug fix step 1 exception.
- Any PR-status request → the **Babysit** playbook (`playbooks/babysit.md`), and not Cursor's built-in babysit skill, whose description matches the same words. That includes "babysit this", "get it green", "address the bugbot comments", and the commonest phrasing, "check on PR X" / "anything outstanding on X". Never triggered by merely opening a PR. Declare its mode before polling. The playbook's step 1 owns the request-to-mode mapping. Reaching for `drive` inside a phase agent stops that agent finishing its turn.
- Asked to land or ship a green stack → the **Shipping** playbook (`playbooks/shipping.md`). Green is not safe. Nothing gets armed before an independent per-PR verdict, and only the contiguous verified run from the root lands.
- Bugbot or the agentic security review commented → skeptical posture. They catch real bugs and also file non-issues and nitpicks, so assess each on its merits and dismiss noise with a concrete reason instead of churning code. Triage fix / dismiss / ask per `references/bugbot-triage.md`.
- Broken skill mid-task → repair it when within the authorized scope; otherwise report the gap and continue unaffected work.
- Long, autonomous, or multi-phase work, or any task the user steps away from to review later ("going to bed", "trust it when i'm back", "/loop until X") → a decision trail via the [pstack-show-me-your-work](../pstack-show-me-your-work/WORKFLOW.md) skill. Commit it when stakes need an auditable record. Keep it local otherwise.

## Principles

Read the leaf WORKFLOW.md in full for any principle you apply. Each entry names when it applies.

**Core**

- **Laziness Protocol** ([pstack-principle-laziness-protocol](../pstack-principle-laziness-protocol/WORKFLOW.md)). Refactoring, sizing a diff, or tempted to add abstractions, layers, or signal threading. Bias to deletion and the smallest change that solves the problem.
- **Foundational Thinking** ([pstack-principle-foundational-thinking](../pstack-principle-foundational-thinking/WORKFLOW.md)). Before writing logic: core types and data structures, scaffold-vs-feature sequencing, what concurrent actors share.
- **Redesign from First Principles** ([pstack-principle-redesign-from-first-principles](../pstack-principle-redesign-from-first-principles/WORKFLOW.md)). Integrating a new requirement into an existing design. Redesign as if it had been foundational from day one.
- **Attack the Premise** ([pstack-principle-attack-the-premise](../pstack-principle-attack-the-premise/WORKFLOW.md)). Two or more fixes that share one premise have failed the same gate. Take a census of which actors hold the imbalance before the next fix, then question the premise instead of writing another fix that assumes it.
- **Subtract Before You Add** ([pstack-principle-subtract-before-you-add](../pstack-principle-subtract-before-you-add/WORKFLOW.md)). Sequencing an addition, refactor, or rewrite. Remove dead weight first, then build on the simpler base.
- **Minimize Reader Load** ([pstack-principle-minimize-reader-load](../pstack-principle-minimize-reader-load/WORKFLOW.md)). Reviewing or shaping code that's hard to trace. Count layers and hidden state, collapse one-caller wrappers, shrink mutable scope.
- **Outcome-Oriented Execution** ([pstack-principle-outcome-oriented-execution](../pstack-principle-outcome-oriented-execution/WORKFLOW.md)). Planned rewrites and migrations with explicit phase boundaries. Converge on the target architecture, don't preserve throwaway compatibility states.
- **Experience First** ([pstack-principle-experience-first](../pstack-principle-experience-first/WORKFLOW.md)). Product, UX, or feature-scope tradeoffs. Choose user delight over implementation convenience.
- **Exhaust the Design Space** ([pstack-principle-exhaust-the-design-space](../pstack-principle-exhaust-the-design-space/WORKFLOW.md)). A novel interaction or architectural decision with no precedent. Build 2-3 competing prototypes and compare before committing.
- **Build the Lever** ([pstack-principle-build-the-lever](../pstack-principle-build-the-lever/WORKFLOW.md)). Any non-trivial work. Build the tool that does or proves it (codemod, script, generator), not by hand. The tool is the artifact a reviewer reruns.

**Architecture**

- **Model the Domain** ([pstack-principle-model-the-domain](../pstack-principle-model-the-domain/WORKFLOW.md)). Writing stateful logic, or code that branches a lot or repeats a shape assumption across files. Encode the domain in a structure (state machine, typed model, table or registry, reducer, boundary, the right collection) instead of scattered conditionals.
- **Boundary Discipline** ([pstack-principle-boundary-discipline](../pstack-principle-boundary-discipline/WORKFLOW.md)). Wiring validation, error handling, or framework adapters. Guards at system boundaries, trust internal types, keep business logic pure.
- **Type System Discipline** ([pstack-principle-type-system-discipline](../pstack-principle-type-system-discipline/WORKFLOW.md)). Designing types or a signature in any typed language. Make illegal states unrepresentable, brand primitives, parse external data at boundaries.
- **Make Operations Idempotent** ([pstack-principle-make-operations-idempotent](../pstack-principle-make-operations-idempotent/WORKFLOW.md)). Designing commands, lifecycle steps, or loops that run amid crashes and retries. Converge to the same end state.
- **Migrate Callers Then Delete Legacy APIs** ([pstack-principle-migrate-callers-then-delete-legacy-apis](../pstack-principle-migrate-callers-then-delete-legacy-apis/WORKFLOW.md)). Introducing a new internal API while old callers exist. Migrate and delete in one wave.
- **Separate Before Serializing Shared State** ([pstack-principle-separate-before-serializing-shared-state](../pstack-principle-separate-before-serializing-shared-state/WORKFLOW.md)). Concurrent actors might write the same file, branch, key, or object. Eliminate the sharing first.

**Verification**

- **Prove It Works** ([pstack-principle-prove-it-works](../pstack-principle-prove-it-works/WORKFLOW.md)). After a task, before declaring done. Verify against the real artifact, not a proxy or "it compiles".
- **Fix Root Causes** ([pstack-principle-fix-root-causes](../pstack-principle-fix-root-causes/WORKFLOW.md)). Debugging. Trace each symptom to its root cause, reproduce first, ask why until you reach it.
- **Sequence Work into Verifiable Units** ([pstack-principle-sequence-verifiable-units](../pstack-principle-sequence-verifiable-units/WORKFLOW.md)). Multi-step work (sweeps, migrations, runs of similar edits) and how you stack commits and PRs. Break work into small units that each end in a check, verify each before the next, and order delivery so the sequence proves itself.
- **Test Behavior, Not Implementation** ([pstack-principle-test-behavior-not-implementation](../pstack-principle-test-behavior-not-implementation/WORKFLOW.md)). Writing, changing, or keeping a test. Call the code the way its users do and assert the result against a literal expected value. If the test would still pass when every imported function returns `undefined`, rewrite the assertion or delete the test.

**Delegation**

- **Guard the Context Window** ([pstack-principle-guard-the-context-window](../pstack-principle-guard-the-context-window/WORKFLOW.md)). Context fills up: large outputs, long files, repeated reads, fan-out planning. Route bulk to subagents, keep summaries in the main thread.
- **Never Block on the Human** ([pstack-principle-never-block-on-the-human](../pstack-principle-never-block-on-the-human/WORKFLOW.md)). Tempted to ask "should I do X?" on reversible work. Proceed, present the result, let the human course-correct.

**Meta**

- **Encode Lessons in Structure** ([pstack-principle-encode-lessons-in-structure](../pstack-principle-encode-lessons-in-structure/WORKFLOW.md)). You catch yourself writing the same instruction a second time. Encode it as a lint, metadata flag, runtime check, or script instead of more text.

## Autonomy

Proceed with authorized work under the owner’s permission and task-scope policy. External messages, cloud use, deployments, and unrelated fixes require the authority that policy specifies. A workflow is not additional authorization.

**Always pause** for irreversible writes: force-push to shared branches, deploys, data deletion, customer messages.

**Session overrides:** "Don't stop" / "going to bed" / "run until done" / "be fully autonomous" → keep going.

**No is an acceptable answer.** Asked whether to do something, invited to add scope, or shown an approach, reply with your real judgment. Decline, push back, or say "this doesn't earn its place" when true. A recommendation is a judgment, not a validation. Agreement is not the default, candor over sycophancy.

## Subagents

Use the [poteto-agent prompt](../pstack/agents/poteto-agent.md) for playbook workers. Routed workflows supply their own role prompts. Check delegation capability and owner authorization first. In Owner Operator, follow its bundled select-harness-for-delegation policy and lifecycle. A delegated child completes its assigned work directly when nesting is forbidden.

Select exact harness, model, and effort from the owner’s current choices and verified capabilities, including panel roles. Never substitute upstream defaults, mutate preferences, or infer cloud authorization. If independent review cannot run, report that limit; local sequential review is not independent evidence.

You own every subagent's work. Review the diff and write your own summary, don't pass through what it said. Interrupt-chained resumes silently drop directives, so fire a fresh subagent with consolidated scope rather than trusting a "done" summary. A second opinion is the same prompt against a different model. Agreement is high-signal.

## Writing the reply

Write the reply clean as you draft it. A cleanup pass after drafting does not remove these patterns.

- **Short declarative sentences.** One thought per sentence, ended with a period.
- **No long-dash character anywhere.** Write a file-list bullet as a sentence ("`main.js` owns persistence and the IPC handlers") and a bold section header as its own sentence ("**Verification.** End to end via CDP").
- **A colon as a mid-sentence connector is also out** (unslop rule 14). A colon before a list is fine.
- **Terse is not an excuse to drop content.** Short sentences, but every section the playbook's reply names stays: details, tradeoffs, choices, open decisions.
- **Frame impact for the consumer and the maintainer.** Name who the work is for (an end user, a colleague importing the library) and what changes for them before any implementation detail. Then what the next engineer who owns this code inherits. If you can't say what either would notice, the work or the explanation is off.
- **Never fabricate a link, citation, or transcript reference.** Link only artifacts you produced or read this session.

Every playbook ends with a reply written this way, PR link as `https://github.com/<owner>/<repo>/pull/<number>`. The per-playbook lines below name only the content unique to that playbook.

## Comments

Comments follow the same rule as the reply. Write them clean as you go. Keep a comment only for a non-obvious *why* the code can't show. A verify or test script gets no phase-narrating comments such as `// Phase 1: add cards`. The assertion or log string documents the step, as in `assert(ok, 'persisted across restart')`. This applies to every file you produce, including the delegate's diff.

## Playbooks

Open a todolist whose first items are the matched playbook's steps, copied in verbatim, before any task-specific todos. A step you choose not to do stays in the list with a one-line `skip: <reason>`. Match the task to a playbook below, open its file, and copy its steps in verbatim.

A large or cross-cutting effort (a migration across many call sites, an ambitious multi-part change), or work the user steps away from to trust later, routes to the [pstack-figure-it-out](../pstack-figure-it-out/WORKFLOW.md) skill even when a narrower playbook like Feature fits. Use [pstack-figure-it-out](../pstack-figure-it-out/WORKFLOW.md) whenever no bundled playbook fits. It designs a bespoke, rigorous playbook for the task. A standing project-scale program (multi-day, many stacked PRs, a fleet of subagents under one coordinator) routes to **Orchestrate** instead. figure-it-out designs one bespoke run, orchestrate runs the program.

- **Investigation.** Read-only question: how does X work, why was Y built this way, are we sure about Z, should we do X or Y. `playbooks/investigation.md`.
- **Bug fix.** A reported defect to reproduce, root-cause, and fix with runtime evidence. `playbooks/bug-fix.md`.
- **Perf issue.** A measured slowness to trace and improve against a baseline. `playbooks/perf-issue.md`.
- **Hillclimb.** Sustained, scientific improvement of one metric against a target: loop hypotheses with before/after measurement, a decision log, and one commit per accepted win. Distinct from Perf issue, which is a one-off fix. `playbooks/hillclimb.md`.
- **Runtime forensics.** Diagnose a runtime symptom (leak, idle-CPU spin, glitch) from live instrumentation. The deliverable is a diagnosis, not a fix. `playbooks/runtime-forensics.md`.
- **Trace forensics.** Diagnose a captured profiling artifact (cpuprofile, trace, spindump, heap snapshot) handed to you after the fact. The deliverable is a diagnosis, not a fix. `playbooks/trace-forensics.md`.
- **Feature.** New or changed behavior, built from a named data shape. `playbooks/feature.md`.
- **Refactoring.** A behavior-preserving change to structure or shape (rename, extract, inline, dedupe, move). `playbooks/refactoring.md`.
- **Prototype.** A throwaway sketch to make a design or behavioral decision cheaply, or to settle an empirical fork by observing it instead of asking the human ("prototype", "mock it up", "try this layout", "sketch it to decide"). `playbooks/prototype.md`.
- **Visual parity.** Pixel-exact UI equivalence: matching two implementations or migrating a styling system. `playbooks/visual-parity.md`.
- **Authoring or modifying a skill.** Writing or editing a SKILL.md. `playbooks/authoring-a-skill.md`.
- **Eval.** Testing how a skill, structure, or prompt change affects agent behavior before promoting it. `playbooks/eval.md`.
- **Babysit.** Driving a PR or a stack to merge-ready: conflicts, review threads, CI. `playbooks/babysit.md`.
- **Shipping.** The half after Babysit. Independently verifying a green stack, then landing the contiguous verified run bottom-up through `gh` by default or Origin when its CLI is available. `playbooks/shipping.md`.
- **Autonomous run.** A long task to drive to completion without stopping ("run until done", "/loop until X"). `playbooks/autonomous-run.md`.
- **Orchestrate.** A standing project handed to one coordinator chat: multi-day, many stacked PRs, dozens to hundreds of subagents, minimal human turns ("run this whole project", "own this migration until it lands"). Distinct from Autonomous run, which drives one task to a predicate. Work one agent could finish inside the session's budget routes there, not here, however program-shaped the phrasing sounds. `playbooks/orchestrate.md`.
- **Autopilot-full.** A queue of independent PRs run to merged with full autonomy. One owner per PR carries build through merge, and the root swarm-verifies each merge-ready head before its owner merges ("autopilot this queue", "full autopilot", one-owner-per-PR programs). `playbooks/autopilot-full.md`.
- **Autopilot-stack.** A queue of changes built and verified with full autonomy, delivered as one linear reviewed base-branch stack the operator lands herself ("autopilot-stack", "stack them, don't ship", "build the stack, I'll land it"). `playbooks/autopilot-stack.md`.
- **Session pickup.** Resuming or taking over a prior agent's in-flight work from a transcript, cloud-agent URL, or pushed branch. `playbooks/session-pickup.md`.
- **Pause safely.** Suspending in-flight work cleanly so it can be resumed, on an explicit pause, going offline, a harness restart, or imminent context compaction. The complement to Session pickup. Full steps: `playbooks/pause-safely.md`.
- **Multi-phase or multi-PR plan.** Work that spans phases or stacked PRs. `playbooks/multi-phase-plan.md`.
- **Worktree and simulator cleanup.** Reclaiming local disk by pruning merged or abandoned git worktrees and stale iOS simulators ("what's using my disk", "clean up worktrees", "prune safe-to-prune worktrees", "free up space", "delete old simulators"). `playbooks/worktree-cleanup.md`.
- **Opening a PR.** Invoked at the end of every other playbook. `playbooks/opening-a-pr.md`.
