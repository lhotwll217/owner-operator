# Roadmap / Backlog

> **Owner-controlled.** Agents/assistants: do **not** add items unless explicitly asked to do so. 

## Scheduling ("monitor the situation")

- [ ] **Scheduled keyword scan.** Run `session-keywords` across all local sessions on a
  recurring schedule (~15–30 min), indexing new `*keyword*` breadcrumbs into the durable
  store (`~/.owner-operator/keywords.db`) for proactive pickups. First piece of the scheduler.

## Onboarding

- [x] **First-run onboarding.** Guided one-time setup as a pi extension (`src/agent/onboarding.ts`)
  + `/onboarding` command, over the config writers/detection in `packages/core/src/onboarding.mjs`.
  Detect-then-verify after OpenClaw ([inspiration](docs/inspiration.md)): privacy blacklist first,
  then sources are *detected* (not configured), then the active-thread window. Runs once (marker at
  `<ooHome>/onboarded.json`), and hands off to the session's own first turn for the ranked reveal.
- [ ] **Always-on handoff.** Onboarding points at the widget; it doesn't yet install the daemon as
  a launchd agent or auto-launch the widget (macOS-only, unverified from CI). Wire the final
  "land in the widget" step once there's a Mac to test it on.
