# session-grep onboarding

Read this on first use on a machine, when `--list-roots` shows the wrong places, or
when adding a transcript format.

## Roots

The folders searched by default are the `DEFAULT_SOURCES` constant near the top of
`session-grep.mjs`, the standard per-user homes for each supported tool. Roots that do
not exist are skipped, so zero config works out of the box. Confirm the map:

```bash
node session-grep.mjs --list-roots
```

| tool | home | format |
|---|---|---|
| Claude Code | `~/.claude/projects` | jsonl (supported) |
| Codex CLI | `~/.codex/sessions`, `~/.codex/archived_sessions` | jsonl (supported) |
| Pi | `~/.pi/agent/sessions` | jsonl (supported) |
| Cursor | `~/Library/Application Support/Cursor/User/workspaceStorage` (macOS), `~/.config/Cursor/...` (linux) | sqlite (not yet parseable) |
| Gemini CLI | `~/.gemini/tmp` | json (not yet parseable) |
| opencode | `~/.local/share/opencode/storage` | split json (not yet parseable) |

Hosts and launchers are not transcript formats. Roots are keyed by adapter `type`
(`claude`, `codex`, `pi`) and directory. Quick existence check:
`ls -d ~/.claude/projects ~/.codex/sessions 2>/dev/null`.

## Searching somewhere else

Four ways, in order of precedence:

1. `--root DIR` per call, no config; format auto-detected. Repeatable.
2. `--sources-file FILE` per call path to a JSON array of `{ type, root }`; use it when
   the directory does not reveal the parser type.
3. `$SESSION_GREP_SOURCES_FILE` env path to the same JSON array, for a global/npx
   install or CI.
4. Edit `DEFAULT_SOURCES` in `session-grep.mjs`. The skill is vendored into your repo
   via `npx skills add`, so this file is yours. Adding a bespoke tool means dropping an
   adapter in `adapters/` and adding a line here; commit both.

`--sources-file` and `$SESSION_GREP_SOURCES_FILE` both *replace* the defaults for that
run. `--root` is an untyped one-off override; to narrow configured typed roots use
`--target-root DIR` (equal to, or a subdirectory of, a configured root, inheriting its
type) with `--sources-file`, not `--root`.

The override file is a plain array:

```json
[
  { "type": "codex", "root": "~/alt/codex/sessions" }
]
```

`type` selects the parser, so a relocated Codex store does not need `codex` in its path.
An override routes a known parser at a directory; it does not teach a new format. A
missing, unparseable, or non-array `--sources-file` fails closed. The ambient
`$SESSION_GREP_SOURCES_FILE` form warns on stderr and falls back to the built-in
defaults; `--list-roots` reports `config_error=true` in that case.

The default routes live in `DEFAULT_SOURCES`, the source resolver in `sources.mjs`, and
parser implementations in `adapters/`.

## Adding a format

One file per tool in `adapters/`, each exporting `{name, detect(file), message(record, opts)}`.
Supporting a new JSONL-based tool means dropping one file there and adding a
`--self-test` fixture; non-JSONL formats also need a reader change in the script.

Adapter contract: every current and future adapter MUST surface readable reasoning
traces as conversation text; only encrypted or opaque reasoning stays skipped. Today:
Claude `thinking` blocks and Codex `agent_reasoning` are surfaced; Codex encrypted
`reasoning` is skipped; Pi persists no standalone reasoning records, only
`thinking_level_change` config events.

Verify after any change or copy:

```bash
node session-grep.mjs --self-test
```
