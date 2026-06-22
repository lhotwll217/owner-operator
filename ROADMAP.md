# Roadmap / Backlog

> **Owner-controlled — the owner drives this file.** Agents/assistants: do **not** add items, check
> boxes, or rewrite this roadmap. Surface suggestions in chat; the owner decides what lands here.

Concrete things to build, beyond the phase-level vision in [VISION.md](VISION.md).

## Scheduling ("monitor the situation")

- [ ] **Scheduled keyword scan.** Run the `session-keywords` skill across all local sessions
  on a recurring schedule (e.g. every 15–30 min) to find and index new `*keyword*`
  breadcrumbs into the durable store (`~/.owner-operator/keywords.db`), so the operator gets
  proactive pickups instead of searching on demand. First concrete piece of the
  "monitor the situation" scheduler.

## Onboarding

- [ ] **First-run onboarding.** A guided one-time setup where the owner sets their config —
  the privacy blacklist (off-limits repos/paths), the active-thread window
  (`settings.json` `activeWindow`, the rolling lookback the sidebar uses), and likely more.
  Mention only — flow intentionally not defined yet.

## Surfaces

- [x] **Rethink the chat cards.** Today's chat cards are redundant with the sidebar. They
  should probably surface only the few top things to focus on right now, not mirror every
  thread. The sidebar stays the live, must-be-100%-accurate representation of global state;
  the chat becomes a focused "what to do next" rather than a second list.
- [ ] **Agent-to-agent startup.** `--json` emits the triage `Thread[]` without lifecycle
  `state`. Think about agent-to-agent optimization: what startup looks like, whether to
  preload context or expose start flags.
