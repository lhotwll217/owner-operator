# Roadmap / Backlog

> **Owner-controlled.** Agents/assistants: do **not** add items unless explicitly asked to do so. 

## Scheduling ("monitor the situation")

- [ ] **Scheduled keyword scan.** Run `session-keywords` across all local sessions on a
  recurring schedule (~15–30 min), indexing new `*keyword*` breadcrumbs into the durable
  store (`~/.owner-operator/keywords.db`) for proactive pickups. First piece of the scheduler.

## Onboarding

- [ ] **First-run onboarding.** Guided one-time setup: privacy blacklist (off-limits
  repos/paths), active-thread window (`settings.json` `activeWindow`), likely more. Flow not
  defined yet.
