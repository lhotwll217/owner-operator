---
name: session-grep
description: >-
  Literal or regex grep across local AI session transcripts with bounded message context. Use when the user asks to search exact words, punctuation, hashtags/patterns, phrases like "why did you", or wants messages before/after a hit. This is for targeted drill-in, not broad topic discovery.
---

# session-grep

Searches local AI CLI session files with exact literal matching or opt-in regex matching and returns only bounded
message context around each hit. Use this when BM25 search is too fuzzy, cannot search
punctuation/common phrases, or when you need a simple pattern like hashtags.

## Onboarding (first use)

The folders searched by default are the `DEFAULT_SOURCES` constant near the top of
`session-grep.mjs` — the standard per-user homes for each supported tool. Roots that
don't exist are skipped, so zero config works out of the box. On first use, run:

```bash
node session-grep.mjs --list-roots
```

Confirm it matches where this machine's sessions actually live. Known session
homes:

| tool | home | format |
|---|---|---|
| Claude Code | `~/.claude/projects` | jsonl (supported) |
| Codex CLI | `~/.codex/sessions`, `~/.codex/archived_sessions` | jsonl (supported) |
| pi | `~/.pi/sessions` (and tools built on pi) | jsonl (supported) |
| Cursor | `~/Library/Application Support/Cursor/User/workspaceStorage` (macOS), `~/.config/Cursor/...` (linux) | sqlite (not yet parseable) |
| Gemini CLI | `~/.gemini/tmp` | json (not yet parseable) |
| opencode | `~/.local/share/opencode/storage` | split json (not yet parseable) |

Hosts and launchers are not transcript formats. Roots are keyed by adapter `type`
(`claude`, `codex`, `pi`) and directory.

Quick existence check: `ls -d ~/.claude/projects ~/.codex/sessions 2>/dev/null`.
There are three ways to search somewhere other than the defaults, in order of
precedence:

1. `--root DIR` — per call, no config; format auto-detected. Repeatable.
2. `$SESSION_GREP_SOURCES_FILE` — path to a JSON array of `{ type, root }` that
   *replaces* the defaults for that run. The single override hook for a global/npx
   install you don't edit, and for CI.
3. Edit `DEFAULT_SOURCES` in `session-grep.mjs` — the skill is vendored into your
   repo via `npx skills add`, so this file is yours. Adding a bespoke tool means
   dropping an adapter in `adapters/` and adding a line here; commit both.

The override file is a plain array:

```json
[
  { "type": "codex", "root": "~/alt/codex/sessions" }
]
```

`type` must be an adapter that session-grep supports (`claude`, `codex`, or `pi` today) —
it selects the parser, so a relocated Codex store does not need `codex` in its path.
An override is authoritative: it does not teach a new format, only routes a known
parser at a directory. If `$SESSION_GREP_SOURCES_FILE` points at a missing,
unparseable, or non-array file, session-grep warns on stderr and falls back to the
built-in defaults rather than failing silently — `--list-roots` reports
`config_error=true` in that case.

The default routes live in `DEFAULT_SOURCES`, the source resolver lives in
`sources.mjs`, and parser implementations live in `adapters/`.

Format support lives in the `adapters/` folder next to the script — one file per
tool, each exporting `{name, detect(file), message(record, opts)}`. Supporting a
new JSONL-based tool means dropping one file in that folder (and adding a
`--self-test` fixture); non-JSONL formats also need a reader change in the script.

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

The script lives NEXT TO THIS FILE (in the repo: `skills/session-grep/session-grep.mjs`; as an
installed skill it sits in this skill's directory). Invoke it by its path relative to
this SKILL.md — shown below as `session-grep.mjs`:

```bash
node session-grep.mjs --query "why did you" --since 7d --limit 12 --before 2 --after 2
node session-grep.mjs --query "sidebar poll triage membership" --any     # multi-word: any-word match, rarity-ranked
node session-grep.mjs --overview                                          # digest of every session
node session-grep.mjs --skim 269a --max-chars 12000                      # one session's conversation, sampled
node session-grep.mjs --list-roots                                        # show the source/root map being searched
node session-grep.mjs --regex --query "#[A-Za-z0-9_][A-Za-z0-9_-]*" --since 7d --limit 20
```

For broad questions (summarize a session, what was X about) start with `--overview`,
then `--skim SESSION_ID`, then targeted `--query` for specifics. For fact questions:
multi-word literal phrases almost never occur verbatim — use `--any` (matches any word,
hits ranked by word rarity, per-word hit counts reported) or a single rare term.
Every hit is a pointer: to read around a promising hit, use `--session <id> --at <idx>`
from its header instead of re-searching with wider context.

Common flags:

- `--query TEXT` literal query, or a JavaScript regex pattern when `--regex` is set
- `--any` match ANY query word; hits ranked by summed word rarity (IDF); reports per-word hit counts so you learn which words are low-signal
- `--regex` treat `--query` as a JavaScript regular expression; useful for hashtags and lightweight patterns
- `--overview` no query needed: one compact digest per session (id, dates, message counts, opening prompt)
- `--skim ID_PREFIX` no query needed: one session's user/assistant conversation, head/tail kept, middle sampled to the output budget
- `--session ID_PREFIX --at INDEX` drill into a hit's pointer: every hit prints `id=` and `idx=` — this returns the exact messages around that index (±5 by default, `--before/--after` to widen) without re-running the search
- `--limit N` max matching messages, default 20; use a high number for "all"
- `--before N` messages before each hit, default 1
- `--after N` messages after each hit, default 1
- `--role user|assistant|all` filter matching messages, default `all`
- `--source claude|codex|pi|all` filter sources, default `all` (values follow the loaded adapters)
- `--since today|Nd|YYYY-MM-DD` filter by message/session timestamp
- `--sort newest|oldest|file` output order, default `newest`
- `--root DIR` search this directory of `*.jsonl` transcripts instead of the default live stores (repeatable)
- `--exclude-re REGEX` skip any transcript whose file path matches this JS regex; applies to every mode (search, `--overview`, `--skim`, `--session`). Repeatable — the hook for layering a path-based privacy filter on top of the tool
- `--list-roots` print the configured source/root map and whether each root exists
- `--max-chars N` output budget, default 8000 — excess hits are omitted with a notice, never dumped
- `--include-tools` also match inside tool_result blocks (excluded by default: they are file/command echoes, ~45% of bytes, and mostly restate the conversation)
- `--case-sensitive` exact case match, useful for all-caps searches
- `--json` machine-readable output (compact, same truncation and budget as text)
- `--self-test` verify the tool against a built-in synthetic corpus (no dependencies) — run this after copying the skill anywhere

## Output rules

Summarize the hits; do not paste long transcript blocks. Give source, id/path, timestamp,
and the compact context needed to understand what happened around the match.
