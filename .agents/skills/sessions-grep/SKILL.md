---
name: sessions-grep
description: >-
  Literal or regex grep across local AI session transcripts with bounded message context, plus SELF-REFLECTION: search Owner Operator's OWN past threads (--source self) to recall what you were previously asked, answered, or reported across invocations — "did I already report on this?", "what did the owner ask before?". Use when the user asks to search exact words, punctuation, hashtags/patterns, phrases like "why did you", wants messages before/after a hit, or to browse/skim a session (--overview/--skim) before drilling in — and PROACTIVELY before answering about past work, to check your own prior threads first.
---

# sessions-grep

Searches local AI CLI session files with exact literal matching or opt-in regex matching and returns only bounded
message context around each hit. Use this when BM25 search is too fuzzy, cannot search
punctuation/common phrases, or when you need a simple pattern like hashtags.

> **Architecture.** This is a thin wrapper around the vendored `session-grep` primitive
> (`vendor/`, a verbatim copy of the standalone [session-grep](https://github.com/lhotwll217/session-grep)
> repo). The primitive does the grepping; the wrapper injects the owner's session sources
> (from `session_sources.json`) and enforces the privacy blacklist — the two things the
> shared primitive must not own. To adopt an upstream release, re-sync `vendor/` (see
> `vendor/UPSTREAM.md`); the wrapper is untouched because the seam is stable.

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
node .agents/skills/sessions-grep/sessions-grep.mjs --query "sidebar poll triage" --any     # multi-word: match any word, rarity-ranked
node .agents/skills/sessions-grep/sessions-grep.mjs --overview --since 7d                    # digest per session — pick the right one first
node .agents/skills/sessions-grep/sessions-grep.mjs --skim 269a                              # one session's conversation, sampled to budget
node .agents/skills/sessions-grep/sessions-grep.mjs --regex --query "#[A-Za-z0-9_][A-Za-z0-9_-]*" --since 7d --limit 20
```

For a broad "what was X about" question, start with `--overview`, then `--skim <id>`, then a
targeted `--query`. For a fact, a multi-word phrase almost never occurs verbatim — use
`--any` (matches any word, ranked by word rarity) or one rare term. Every hit prints `id=`
and `idx=`; drill in with `--session <id> --at <idx>` instead of re-searching wider.

Common flags:

- `--query TEXT` literal query, or a JavaScript regex pattern when `--regex` is set
- `--any` match ANY query word; hits ranked by summed word rarity (reports per-word hit counts)
- `--regex` treat `--query` as a JavaScript regular expression; useful for hashtags and lightweight patterns
- `--overview` no query: one compact digest per session (id, dates, counts, opening prompt)
- `--skim ID` no query: one session's conversation, head/tail kept, middle sampled to budget
- `--session ID --at IDX` drill into a hit's pointer (from its `id=`/`idx=`) without re-searching
- `--limit N` max matching messages, default 20; use a high number for "all"
- `--before N` / `--after N` messages before/after each hit, default 1
- `--role user|assistant|all` filter matching messages, default `all`
- `--source claude|codex|self|all` filter sources, default `all` (the owner's coding sessions; `self` is never included — see below)
- `--surface tui|chat|interactive|one-shot` narrow `self` hits to one oo surface
- `--since today|7d|YYYY-MM-DD` filter by message/session timestamp
- `--max-chars N` output budget (default 8000; `--skim` 16000) — excess hits are omitted, never dumped
- `--include-tools` also match inside tool-output blocks (excluded by default: mostly file/command echoes)
- `--sort newest|oldest|file` output order, default `newest`
- `--case-sensitive` exact case match, useful for all-caps searches
- `--json` machine-readable output

### Where it searches (and what stays private)

Roots come from the owner's config — the same `session_sources.json` the triage scan uses
(built-in `claude`/`codex` homes plus any `add`/`disable`; sessions the owner relocated are
honored without editing this skill). The privacy **blacklist** (`<OO_HOME>/blacklist.json`)
is absolute: a session in a blacklisted tree is never returned, in any mode — no flag
bypasses it. (Cursor/PostHog Code sessions appear in triage but not here: the grep primitive
has no parser for those formats yet, so they're left out rather than mis-read.)

## Self-reflection: `--source self`

`self` targets Owner Operator's OWN past threads, stored separately from the owner's coding
sessions in `<OO_HOME>/sessions` (default `~/.owner-operator/sessions`). EVERY oo surface
saves there — owner chats (`tui`, plain `chat`, pi `interactive`) and the agent channel
(`one-shot`) — and every invocation stamps an `oo-provenance` entry: the surface,
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
