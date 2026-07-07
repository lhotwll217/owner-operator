---
name: get-current-session-state
description: >-
  Read the owner's current managed session state — the exact rows their widget shows, with
  row number, id, repo, topic, status, priority, summary, and next step. The source of
  truth for "what's ongoing" / "what needs me": start every triage here.
allowed-tools: get_current_session_state
---

# get-current-session-state

Call `get_current_session_state`. It returns the reconciled snapshot the daemon serves to
every surface (the widget, terminal, and session-state callers) — membership, order,
active/done state, and the cached triage enrichment (priority, summary, next step).

- Every active row belongs in a "what's ongoing" triage unless the owner explicitly
  filtered it out.
- Need message content or discovery? The `scan-active-transcripts` skill — merge its
  results with these rows, never substitute.
- Read-only; mutations go through the `mark-done` skill.
