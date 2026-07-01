# Roadmap / Backlog

> **Owner-controlled.** Agents/assistants: do **not** add items unless explicitly asked to do so. 

Concrete things to build.

## Scheduling ("monitor the situation")

- [ ] **Scheduled keyword scan.** Run `session-keywords` across all local sessions on a
  recurring schedule (~15–30 min), indexing new `*keyword*` breadcrumbs into the durable
  store (`~/.owner-operator/keywords.db`) for proactive pickups. First piece of the scheduler.

## Onboarding

- [ ] **First-run onboarding.** Guided one-time setup: privacy blacklist (off-limits
  repos/paths), active-thread window (`settings.json` `activeWindow`), likely more. Flow not
  defined yet.

## Surfaces

- [ ] **Rethink the chat cards.** They mirror the sidebar — redundant. Chat should surface
  only the top few things to focus on; the sidebar stays the live, 100%-accurate global
  state, chat becomes "what to do next."
- [ ] **Agent-to-agent startup.** `--json` emits triage `Thread[]` without lifecycle `state`.
  Decide what agent-to-agent startup looks like — preload context, expose start flags.
- [ ] **Assess pi interactive-mode vs hand-rolled TUI.** Whether to adopt pi's
  `modes/interactive` (commands, effort-cycle, paste for free) and whether the sidebar earns
  its place vs a chat-first shape. Research first.
  ([#7](https://github.com/lhotwll217/owner-operator/issues/7))
