---
name: mark-done
description: >-
  Mark current Owner Operator threads done/inactive. Use when the user says a visible
  thread, row number, repo, topic, or named current thread is done, resolved, inactive,
  or should be removed from the active list.
allowed-tools: mark_thread_done
---

# mark-done

Marks threads in the current session state done. It does not present rows, scan
transcripts, recompute triage, or load session files.

Call `mark_thread_done` with:

- `ids` for stable thread ids.
- `indexes` for visible row numbers.
- `queries` for user-provided names, repos, or topic snippets.

If the tool reports unresolved or ambiguous queries, say so briefly instead of falling
back to transcript scans.
