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

`keywords.csv` is the source of truth for known keywords.

Each row defines:

- `keyword` - the canonical keyword
- `description` - what the keyword means and when to use it

Do not hard-code keyword meanings in this skill. Read `keywords.csv` when keyword semantics
matter.

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

When asked to find a keyword breadcrumb:

1. Read `keywords.csv` to resolve the keyword and its meaning.
2. Search sessions for marker-notation matches of that keyword.
3. Return bounded surrounding context, not full transcripts.
4. Prefer recent matches first when no stronger filter is given.

## Output Rules

Return concise hits with source, id/path, timestamp, keyword, description, and bounded
context. Do not paste long transcripts.
