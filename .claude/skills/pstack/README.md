# Portable pstack

Ported on 2026-09-09 from Lauren Tan’s [pstack 0.15.0](https://github.com/cursor/plugins/tree/df3fb154fb982fb83f649de8646d4af6a0cb16b3/pstack), commit `df3fb154fb982fb83f649de8646d4af6a0cb16b3`. All 47 registered upstream skills, their references, 23 playbooks, helpers, and two agent prompts are included. Copyright © 2026 Lauren Tan; [MIT license](LICENSE). Cursor plugin metadata, branding, and the dormant Benny automation pack are not installed. The linked upstream tree preserves their provenance.

## Use

Start with `pstack-poteto-mode`, `pstack-create-verification-skill`, or `pstack-maintain-verification-skill`. In Owner Operator use `/skill:pstack-poteto-mode`; in Codex use `$pstack-poteto-mode`; in Claude Code use `/pstack-poteto-mode` (flat symlink install) or `/pstack:pstack-poteto-mode` (plugin install). `pstack` opens this index. Every upstream skill name has the `pstack-` prefix, so existing skills such as `tdd` remain separate. Prototype is a poteto-mode playbook, not a separate upstream skill.

All entry points are user-invoked (`disable-model-invocation: true`, plus Codex’s `policy.allow_implicit_invocation: false`). They apply only to the requested task. Where a host ignores these extensions, treat their descriptions as explicit-request-only. Cross-workflow steps read linked **WORKFLOW.md reference files**; they do not programmatically invoke hidden user-only commands. Unprefixed workflow labels in upstream prose refer to the corresponding namespaced workflow below, never a same-named local skill. Read only the selected branches and principles.

Source folders live beside this folder in `/Users/otwell/Development/skills/plugins/pstack/skills` (the `pstack` plugin of the `lhotwll217-skills` marketplace). Symlinks expose them through `~/.agents/skills`, Owner Operator’s workspace skills, and Claude Code’s existing skill root. Codex discovers the personal `.agents/skills` route. Install or move the collection together because sibling links are intentional. No second skill registry or preference store is used. Owner Operator interactive sessions need `/reload` or a new session; coding-agent sessions should be restarted or refreshed before use.

Resolve links relative to the containing file, following symlinks. Bare `scripts/`, `references/`, and `playbooks/` paths refer to the owning workflow folder. For shell examples containing `PSTACK_ROOT`, set it to the absolute directory containing this README, discovered from this entry point. Generated project paths and angle-bracket examples are outputs to ground in the target project, not installed files.

## Policy and capabilities

Owner instructions, task scope, permissions, delegation, session privacy, and model-selection policies take precedence over every workflow and principle. Installation grants no authority to execute workflows, publish, send messages, change model preferences, create automations or scheduled jobs, or enable cloud services. Keep internal planning and decision trails in the owner’s established workspace, outside product PRs unless intentionally shipped documentation is authorized. Follow the local writing-for-agents and Chain of Context guidance when authoring or placing artifacts.

- **Delegation and models.** Inspect the current tool catalog before a fan-out. Owner Operator uses its bundled `select-harness-for-delegation` skill and `delegate_agent` lifecycle when exposed; its owner-selected identities, approved baselines, retry rules, and no-poll policy govern. Other harnesses use only their advertised delegation API. The [poteto-agent](agents/poteto-agent.md) and [Comment Sicko](agents/comment-sicko.md) files are prompts to pass to supported workers, not installed subagent types. A child forbidden to delegate completes its task directly. Sequential local passes retain coverage, but cannot claim independent or multi-model review. If that independence is a completion gate, report it unmet. No upstream model default or silent downgrade applies.

- **Session evidence.** In Owner Operator, read the bundled `session-search` skill at `$OO_INSTALL_ROOT/src/agent/skills/session-search/SKILL.md` and use its privacy-aware helper. In this local coding setup the same policy and helper are available under `/Users/otwell/Development/owner-operator/src/agent/skills/session-search/`; read that skill first. Use stable IDs, bounded windows, configured stores, and `--include-tools` for execution claims. On another installation resolve its approved session-search route; if unavailable, report the gap or use a labeled digest of the current conversation. Never bypass exclusions by reading raw transcript files. The worktree helper deliberately reports session use as unknown.

- **Skill authoring.** Cursor’s built-in `create-skill` is not installed. The verified local replacement is `/Users/otwell/Development/owner-operator/src/agent/skills/writing-for-agents/SKILL.md` and its `SKILL-MECHANICS.md`, supplemented by an available skill-creator for scaffolding or validation when needed. Elsewhere resolve the host’s installed authoring guidance. Use the project’s established skill home and supported discovery route. A generated verification skill is a draft until its own live proof succeeds.

- **Driving and cleanup.** `cursor-team-kit`’s `control-cli`, `control-ui`, and `deslop` are not bundled or assumed installed. For CLI/TUI proof, inspect the repo’s tests, PTY/expect helpers, or an exposed terminal tool. For UI proof, inspect available browser-control skills and tools or the project’s Playwright/Cypress/CDP harness. This installation has browser-control skill entries and a terminal capability, but their ability to drive any particular app is untested. Missing controls remain a verification gap. For deslop, inspect the diff under the repo’s lint/review rules and pstack’s code principles; this is a manual substitute, not cursor-team-kit execution. The bundled babysit playbook replaces the external babysit dependency when pstack is requested.

- **Waits and optional services.** Cursor `/loop`, cloud-sleeper, and cloud launch fields are not portable APIs. Use an exposed in-session event/wait mechanism without installing jobs. If the host cannot sustain and resume an unattended run, report that limit. `make-bot-ui` requires verified webhook-routine and secure secret-input capabilities and explicit service authorization; these are not provided here. Source-specific MCP recipes are examples: inspect actual tool schemas, permissions, authentication, and data schemas before use. An unavailable source remains an explicit gap.

- **Helpers.** Node runs `pstack-poteto-mode/scripts/check-plan.mjs`; Bash runs the worktree audit and decision-log helper. Worktree audit also uses git, gh, jq, and system utilities, and refreshes remote refs. `orch` and `watch-pr` require Bun and the locked packages in the scripts folder. Bun is absent in this installation and those runtime paths are untested. Bootstrap now fails with setup instructions rather than installing packages automatically. An explicitly requested setup can run `bun install --frozen-lockfile` in that folder after Bun is available. `watch-pr` needs authenticated `gh` and supports GitHub only; its merge options can write remotely. `orch` is an optional task-state helper, never a replacement for Owner Operator’s delegated-run record. Graphite and Origin integrations require separately verified installations.

## Workflows

The links below open reference instructions. Their folder names are also the explicit invocation names.

- [pstack-architect](../pstack-architect/WORKFLOW.md) — Explore competing type and module designs before implementation.
- [pstack-arena](../pstack-arena/WORKFLOW.md) — Compare candidate artifacts, select a base, and combine proven strengths.
- [pstack-automate-me](../pstack-automate-me/WORKFLOW.md) — Draft a personal working-style skill from scoped history and owner input.
- [pstack-blast-radius](../pstack-blast-radius/WORKFLOW.md) — Find downstream breakage and test the facts a change depends on.
- [pstack-bro](../pstack-bro/WORKFLOW.md) — Restate the last response in plain language.
- [pstack-create-verification-skill](../pstack-create-verification-skill/WORKFLOW.md) — Generate and prove a project verification skill and feature map.
- [pstack-figure-it-out](../pstack-figure-it-out/WORKFLOW.md) — Design a task-specific workflow with verifiable completion gates.
- [pstack-how](../pstack-how/WORKFLOW.md) — Trace code structure and behavior to explain how a system works.
- [pstack-interrogate](../pstack-interrogate/WORKFLOW.md) — Review changes adversarially and synthesize evidence-backed findings.
- [pstack-maintain-verification-skill](../pstack-maintain-verification-skill/WORKFLOW.md) — Check every mapped feature against source and live behavior.
- [pstack-make-bot-ui](../pstack-make-bot-ui/WORKFLOW.md) — Build a webhook bot UI when routine and secret-input capabilities exist.
- [pstack-no-comments](../pstack-no-comments/WORKFLOW.md) — Review comments, preserve required exceptions, and address accepted findings.
- [pstack-poteto-mode](../pstack-poteto-mode/WORKFLOW.md) — Route a requested engineering task through pstack playbooks and principles.
- [pstack-principle-attack-the-premise](../pstack-principle-attack-the-premise/WORKFLOW.md) — attack the premise.
- [pstack-principle-boundary-discipline](../pstack-principle-boundary-discipline/WORKFLOW.md) — boundary discipline.
- [pstack-principle-build-the-lever](../pstack-principle-build-the-lever/WORKFLOW.md) — build the lever.
- [pstack-principle-encode-lessons-in-structure](../pstack-principle-encode-lessons-in-structure/WORKFLOW.md) — encode lessons in structure.
- [pstack-principle-exhaust-the-design-space](../pstack-principle-exhaust-the-design-space/WORKFLOW.md) — exhaust the design space.
- [pstack-principle-experience-first](../pstack-principle-experience-first/WORKFLOW.md) — experience first.
- [pstack-principle-fix-root-causes](../pstack-principle-fix-root-causes/WORKFLOW.md) — fix root causes.
- [pstack-principle-foundational-thinking](../pstack-principle-foundational-thinking/WORKFLOW.md) — foundational thinking.
- [pstack-principle-guard-the-context-window](../pstack-principle-guard-the-context-window/WORKFLOW.md) — guard the context window.
- [pstack-principle-laziness-protocol](../pstack-principle-laziness-protocol/WORKFLOW.md) — laziness protocol.
- [pstack-principle-make-operations-idempotent](../pstack-principle-make-operations-idempotent/WORKFLOW.md) — make operations idempotent.
- [pstack-principle-migrate-callers-then-delete-legacy-apis](../pstack-principle-migrate-callers-then-delete-legacy-apis/WORKFLOW.md) — migrate callers then delete legacy apis.
- [pstack-principle-minimize-reader-load](../pstack-principle-minimize-reader-load/WORKFLOW.md) — minimize reader load.
- [pstack-principle-model-the-domain](../pstack-principle-model-the-domain/WORKFLOW.md) — model the domain.
- [pstack-principle-never-block-on-the-human](../pstack-principle-never-block-on-the-human/WORKFLOW.md) — never block on the human.
- [pstack-principle-outcome-oriented-execution](../pstack-principle-outcome-oriented-execution/WORKFLOW.md) — outcome oriented execution.
- [pstack-principle-prove-it-works](../pstack-principle-prove-it-works/WORKFLOW.md) — prove it works.
- [pstack-principle-redesign-from-first-principles](../pstack-principle-redesign-from-first-principles/WORKFLOW.md) — redesign from first principles.
- [pstack-principle-separate-before-serializing-shared-state](../pstack-principle-separate-before-serializing-shared-state/WORKFLOW.md) — separate before serializing shared state.
- [pstack-principle-sequence-verifiable-units](../pstack-principle-sequence-verifiable-units/WORKFLOW.md) — sequence verifiable units.
- [pstack-principle-subtract-before-you-add](../pstack-principle-subtract-before-you-add/WORKFLOW.md) — subtract before you add.
- [pstack-principle-test-behavior-not-implementation](../pstack-principle-test-behavior-not-implementation/WORKFLOW.md) — test behavior not implementation.
- [pstack-principle-type-system-discipline](../pstack-principle-type-system-discipline/WORKFLOW.md) — type system discipline.
- [pstack-recall](../pstack-recall/WORKFLOW.md) — Reconstruct scoped working context from approved session and project evidence.
- [pstack-reflect](../pstack-reflect/WORKFLOW.md) — Review session lessons and propose concrete skill improvements.
- [pstack-setup-pstack](../pstack-setup-pstack/WORKFLOW.md) — Inspect pstack role support using existing owner model-selection policy.
- [pstack-show-me-your-work](../pstack-show-me-your-work/WORKFLOW.md) — Keep a task decision trail in the owner’s established workspace.
- [pstack-swarm](../pstack-swarm/WORKFLOW.md) — Partition work or compare attempts using authorized execution capabilities.
- [pstack-tdd](../pstack-tdd/WORKFLOW.md) — Reproduce a bug with a focused failing test before fixing it.
- [pstack-teach](../pstack-teach/WORKFLOW.md) — Explain what a system does, how it works, and why.
- [pstack-technical-writing](../pstack-technical-writing/WORKFLOW.md) — Apply layered structure and sentence guidance to technical writing.
- [pstack-typescript-best-practices](../pstack-typescript-best-practices/WORKFLOW.md) — Apply pstack’s TypeScript modeling and boundary guidance.
- [pstack-unslop](../pstack-unslop/WORKFLOW.md) — Remove formulaic prose while preserving meaning and voice.
- [pstack-why](../pstack-why/WORKFLOW.md) — Investigate design rationale across available evidence sources.
