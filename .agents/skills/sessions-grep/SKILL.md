---
name: sessions-grep
description: >-
  Search local coding-agent session transcripts with bounded message context: literal or regex grep for exact text, punctuation, or patterns, and browsing or skimming one session before drilling in. Sources cover the owner's coding sessions and, when explicitly pointed at its session directory, Owner Operator's own past threads.
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
node .agents/skills/sessions-grep/sessions-grep.mjs --query "session state poll triage" --any     # multi-word: match any word, rarity-ranked
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
- `--target-type claude|codex|all` narrow to one parser/source type, default `all` (the owner's coding sessions)
- `--since today|7d|YYYY-MM-DD` filter by message/session timestamp
- `--sources-file FILE` when calling the vendored primitive directly, use a JSON array of typed `{ type, root }` sources instead of defaults
- `--target-root DIR` when calling the vendored primitive directly, narrow a sources file to a configured root while preserving its parser type
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
bypasses it. Withheld hits don't shortchange `--limit` (the wrapper backfills past them),
and when results still come up short the output says so (`blacklisted_dropped=N`). (Cursor/PostHog Code sessions appear in triage but not here: the grep primitive
has no parser for those formats yet, so they're left out rather than mis-read.)

## Owner Operator Sessions

Owner Operator's own past threads are stored separately from the owner's coding sessions in
`<OO_HOME>/sessions` (default `~/.owner-operator/sessions`). To search them, point the
vendored grep primitive at the normal typed sources file and target that configured root.
The sources file maps the folder to the `pi` parser; do not repeat parser selection with
`--target-type pi`, and do not add an OO-only source alias to the wrapper.

Use it to recall what Owner Operator was previously asked and answered across invocations,
for example "did I already report on this thread?" or "what did we decide about the widget?".
The output source will be `pi` because these are pi-format session files, but the target is
the root path.

The stable sources file should include the Owner Operator root alongside any other allowed
roots:

```json
[{ "type": "pi", "root": "~/.owner-operator/sessions" }]
```

```bash
OO_HOME="${OO_HOME:-$HOME/.owner-operator}"
node .agents/skills/sessions-grep/vendor/session-grep.mjs --sources-file "$OO_HOME/session-grep-sources.json" --target-root "$OO_HOME/sessions" --query "widget rollout" --since 7d
node .agents/skills/sessions-grep/vendor/session-grep.mjs --sources-file "$OO_HOME/session-grep-sources.json" --target-root "$OO_HOME/sessions" --overview --since 7d
```

## Output rules

Summarize the hits; do not paste long transcript blocks. Give source, id/path, timestamp,
and the compact context needed to understand what happened around the match.
