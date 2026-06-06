---
name: sessions-grep
description: >-
  Literal grep across local AI session transcripts with bounded message context. Use when the user asks to search exact words, punctuation, phrases like "why did you", or wants messages before/after a hit. This is for targeted drill-in, not broad topic discovery.
---

# sessions-grep

Searches local AI CLI session files with exact literal matching and returns only bounded
message context around each hit. Use this when BM25 search is too fuzzy or cannot search
punctuation/common phrases.

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
node /Users/otwell/Development/owner-operator/.agents/skills/sessions-grep/sessions-grep.mjs --query "why did you" --since 7d --limit 12 --before 2 --after 2
```

Common flags:

- `--query TEXT` required literal query
- `--limit N` max matching messages, default 20; use a high number for "all"
- `--before N` messages before each hit, default 1
- `--after N` messages after each hit, default 1
- `--role user|assistant|all` filter matching messages, default `all`
- `--source claude|codex|all` filter sources, default `all`
- `--since today|7d|YYYY-MM-DD` filter by message/session timestamp
- `--sort newest|oldest|file` output order, default `newest`
- `--case-sensitive` exact case match, useful for all-caps searches
- `--json` machine-readable output

## Output rules

Summarize the hits; do not paste long transcript blocks. Give source, id/path, timestamp,
and the compact context needed to understand what happened around the match.
