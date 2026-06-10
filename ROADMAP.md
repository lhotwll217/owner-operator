# Roadmap / Backlog

> **Owner-controlled — Luke drives this file.** Agents/assistants: do **not** add items, check
> boxes, or rewrite this roadmap. Surface suggestions in chat; the owner decides what lands here.

Concrete things to build, beyond the phase-level vision in [VISION.md](VISION.md).

## Scheduling ("monitor the situation")

- [ ] **Scheduled keyword scan.** Run the `session-keywords` skill across all local sessions
  on a recurring schedule (e.g. every 15–30 min) to find and index new `*keyword*`
  breadcrumbs into the durable store (`~/.owner-operator/keywords.db`), so the operator gets
  proactive pickups instead of searching on demand. First concrete piece of the
  "monitor the situation" scheduler.
