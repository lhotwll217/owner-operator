---
name: get-active-threads
description: >-
  Triage the user's ongoing local CLI agent sessions (Claude Code, Codex) — what's active,
  what needs a reply, what they left open. Use when asked "what's ongoing", "what threads
  do I have today", "what needs me", "what did I leave open", or to summarize/prioritize
  active work across sessions. Runs a cheap deterministic scan; never loads full transcripts
  into the model.
allowed-tools: bash present_threads
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
node /Users/otwell/Development/owner-operator/.agents/skills/get-active-threads/get-active-threads.mjs --since today --sample 4
```

Flags:
- `--since today | 7d | 2026-06-04` — window (default `today`)
- `--sample N` — keep the first N + most-recent N messages per thread (default 4; `--bookends`/`--last` are aliases)
- `--limit N` — max threads (default 40)
- `--all` — include automated/worker one-shots (hidden by default)
- `--json` — machine-readable output (use when you want to post-process)
- `--truncate N` — per-message char cap (default 280)

## Then: present via the `present_threads` tool (required)

**You MUST present the result by calling the `present_threads` tool. Do NOT write the
triage as prose, a list, or a table — the only way threads reach the operator is the tool
call.** The UI renders the tool payload as cards.

For each thread, reason over its `firstMessages` (what it was about) and `recentMessages`
(where it stands now) and fill one entry:

- `topic` — what the thread is about.
- `summary` — one sentence on what has generally gone on / current state.
- `nextSteps` — one short clause: the concrete next action (what's it waiting on).
- `repo`, `app` — copy from the digest.
- `created`, `lastActive` — copy the **relative** times from the digest ("2 hours ago").
- `link` — only if the digest gives one.

Order the array most-urgent first (mid-conversation threads waiting on a decision/approval
/ MR review before resolved or "done" ones). Never paste the raw tail back verbatim.

## Drilling into one thread

If the user wants more on a single thread, that's the only time to go deeper — read just
that one via the `ai-sessions` MCP `get_session` (small page) or rerun this with a tighter
`--limit`. Never expand all threads.
