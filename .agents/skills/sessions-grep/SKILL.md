---
name: sessions-grep
description: >-
  Literal or regex grep across local AI session transcripts with bounded message context. Use when the user asks to search exact words, punctuation, hashtags/patterns, phrases like "why did you", or wants messages before/after a hit. This is for targeted drill-in, not broad topic discovery.
---

# sessions-grep

Searches local AI CLI session files with exact literal matching or opt-in regex matching and returns only bounded
message context around each hit. Use this when BM25 search is too fuzzy, cannot search
punctuation/common phrases, or when you need a simple pattern like hashtags.

## When to use

- "grep sessions for ..."
- "search exact phrase ..."
- "find where I asked why did you ..."
- punctuation searches like `?`
- any request for messages before/after a specific text hit

## Retrieval principle

When no stronger filtering criteria is given, treat **recency as the default heuristic for
relevance**. Search newest-first and prefer a recent window (`--since today`, `--since 7d`,
or another explicit date) before expanding all-time. Only broaden when recent results are
missing or insufficient.

## How to use

```bash
node .agents/skills/sessions-grep/sessions-grep.mjs --query "why did you" --since 7d --limit 12 --before 2 --after 2
node .agents/skills/sessions-grep/sessions-grep.mjs --regex --query "#[A-Za-z0-9_][A-Za-z0-9_-]*" --since 7d --limit 20
```

Common flags:

- `--query TEXT` required literal query, or a JavaScript regex pattern when `--regex` is set
- `--regex` treat `--query` as a JavaScript regular expression; useful for hashtags and lightweight patterns
- `--limit N` max matching messages, default 20; use a high number for "all"
- `--before N` messages before each hit, default 1
- `--after N` messages after each hit, default 1
- `--role user|assistant|all` filter matching messages, default `all`
- `--source claude|codex|self|all` filter sources, default `all` (the owner's coding sessions; `self` is never included — see below)
- `--surface tui|chat|interactive|rpc|one-shot` narrow `self` hits to one oo surface
- `--since today|7d|YYYY-MM-DD` filter by message/session timestamp
- `--sort newest|oldest|file` output order, default `newest`
- `--case-sensitive` exact case match, useful for all-caps searches
- `--json` machine-readable output

## Self-reflection: `--source self`

`self` targets Owner Operator's OWN past threads, stored separately from the owner's coding
sessions in `<OO_HOME>/sessions` (default `~/.owner-operator/sessions`). EVERY oo surface
saves there — owner chats (`tui`, plain `chat`, pi `interactive`) and the agent channel
(`rpc`, `one-shot`) — and every invocation stamps an `oo-provenance` entry: the surface,
owner-vs-agent origin, the caller's cwd + repo name, and (when the caller identifies itself
via `--from-session` / `OO_FROM_SESSION`) the coding session id that made the call — an
audit trail of who touched each thread.

Use it to recall what you were previously asked and answered across invocations — e.g. "did
I already report on this thread?", "what did the owner ask in the TUI?". Surface matters:
filter with `--surface`, and grep by repo via the `repo=` label in hits (or `provenance` in
`--json`). `self` is deliberately excluded from `--source all`, so searches of the owner's
sessions never surface oo's own threads; target it explicitly:

```bash
node .agents/skills/sessions-grep/sessions-grep.mjs --source self --query "widget rollout" --since 7d
node .agents/skills/sessions-grep/sessions-grep.mjs --source self --surface tui --query "mark done"
```

## Output rules

Summarize the hits; do not paste long transcript blocks. Give source, id/path, timestamp,
and the compact context needed to understand what happened around the match.
