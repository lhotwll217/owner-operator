---
name: session-keywords
description: >-
  Use intentional keyword breadcrumbs across local AI sessions for downstream workflows and knowledge organization. Use when the user mentions session keywords, breadcrumbs, or wants marked context recovered.
---

# session-keywords

Keywords are a distributed breadcrumb framework for AI sessions. A keyword is an intentional,
grepable marker that can be left in any session so future workflows can recover the marked
moment and its surrounding context.

## Source of Truth

Keyword definitions live in a durable SQLite store at `~/.owner-operator/keywords.db`
(auto-created and seeded from the versioned `keywords.csv` on first run — zero external deps,
uses Node's built-in `node:sqlite`). `keywords.csv` is the committed seed.

Each keyword has:

- `keyword` - the canonical keyword
- `description` - what it means and when to use it

Use the `session-keywords.mjs` script to read, search, and add keywords — don't read the
store directly, and don't hard-code keyword meanings here.

## Keyword Shape

Canonical keywords in `keywords.csv` should be:

- lowercase
- space-separated
- short enough to type naturally in a session
- specific enough to be useful as a retrieval breadcrumb

Keyword breadcrumbs in sessions should use marker notation:

```text
*keyword name*
```

For example, a canonical CSV keyword `high signal` should be written in-session as
`*high signal*` or `* high signal *`. Search should require this marker notation to avoid
noise from common speech, while still being forgiving across case and whitespace.

## How to Use

Run the script from the repo root:

- **List known keywords**: `node .agents/skills/session-keywords/session-keywords.mjs --list`
- **Find a breadcrumb**: `… --keyword "NAME"` (optionally `--since 7d`, `--source claude|codex`,
  `--before N`, `--after N`, `--json`) — searches sessions for `*NAME*` marker notation and
  returns bounded before/after context.
- **Add a keyword (durable)**: `… --add --keyword "NAME" --description "..."` — persists to the
  SQLite store.

Resolve the keyword via `--list` first, then search. Return bounded context, never full
transcripts. Prefer recent matches when no stronger filter is given.

## Output Rules

Return concise hits with source, id/path, timestamp, keyword, description, and bounded
context. Do not paste long transcripts.
