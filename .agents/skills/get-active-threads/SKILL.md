---
name: get-active-threads
description: >-
  Triage the user's ongoing local CLI agent sessions (Claude Code, Codex) — what's active,
  what needs a reply, what they left open. Use when asked "what's ongoing", "what threads
  do I have today", "what needs me", "what did I leave open", or to summarize/prioritize
  active work across sessions. Runs a cheap deterministic scan; never loads full transcripts
  into the model.
---

# get-active-threads

Surfaces recently-active agent threads with their **tail** (last few messages) so you can
triage what needs the user — **without** burning context on full transcripts. The gather is
a deterministic script; you (the model) only read its small, pre-digested output.

## When to use

- "What ongoing threads do I have from today?" · "what needs me?" · "what's still open?"
- Any request to review or prioritize active work across the user's CLI agent sessions.

## How to use

Run the bundled script. **Do this instead of reading session files or calling session MCP
tools yourself** — those overflow context and cost tokens.

```bash
node /Users/otwell/Development/owner-operator/.agents/skills/get-active-threads/get-active-threads.mjs --since today --last 6
```

Flags:
- `--since today | 7d | 2026-06-04` — window (default `today`)
- `--last N` — trailing messages per thread (default 6)
- `--limit N` — max threads (default 40)
- `--all` — include automated/worker one-shots (hidden by default)
- `--json` — machine-readable output (use when you want to post-process)
- `--truncate N` — per-message char cap (default 280)

## Then: present a prioritized summary

Read the digest and hand the user a prioritized, terse summary:

- **Lead with what needs them now** — threads mid-conversation where the last turn implies a
  pending decision, a draft to approve, or an MR/PR to review. Infer "what it's waiting on"
  from the tail.
- One line per thread: `project · topic · what it's waiting on · weight ("just say go" vs
  "needs review")`. Then a short **FYI/closed** group for resolved ones (e.g. last turn was
  a thank-you / "done").
- Give the `id` + `source` so they can drill in. Never paste the raw tail back verbatim.

## Drilling into one thread

If the user wants more on a single thread, that's the only time to go deeper — read just
that one via the `ai-sessions` MCP `get_session` (small page) or rerun this with a tighter
`--limit`. Never expand all threads.
