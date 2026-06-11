---
name: mark-done
description: >-
  Mark current Owner Operator sidebar threads done/inactive. Use when the user says a
  visible sidebar thread, row number, repo, topic, or named current thread is done,
  resolved, inactive, or should be removed from the active list.
allowed-tools: mark_thread_done
---

# mark-done

Use this only to mark current sidebar threads done. It does not present sidebar
rows, scan transcripts, recompute triage, or load session files.

## Workflow

Call `mark_thread_done` with:

- `ids` for stable thread ids.
- `indexes` for visible sidebar row numbers.
- `queries` for user-provided names, repos, or topic snippets.

If the tool reports unresolved or ambiguous queries, say that briefly instead of falling
back to transcript scans.
