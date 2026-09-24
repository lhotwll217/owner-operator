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

## First run on a machine

A search prints `sources=defaults` when no source config is in effect. That field is the
switch. It has one on position and two off positions, and nothing to judge:

- **on** — no config exists. Every search prints the field. Do the steps below.
- **off** — a config exists and lists the roots this machine should search.
- **off** — a config exists and lists exactly the built-in roots, which records that the
  defaults were checked and are right.

Writing the file flips it and the field never appears again. There is no per-session
check, no second condition, and no state kept beyond that one file. Do not judge whether
this machine "needs" it: if the field prints, it has not been done.

```bash
node session-grep.mjs --list-roots                     # note origin= and every root
find ~ -maxdepth 4 -name '*.jsonl' -not -path '*/node_modules/*' 2>/dev/null \
  | sed 's|/[^/]*$||' | sort -u | head -40             # directories holding transcripts
```

Compare the two. A directory in the second list that no root in the first covers is a
store this machine will never search. If it is a supported format, add it to a config
file, not to the skill. An agent reading this can do all of it: run both commands, show
the user what is uncovered, and write the file.

Write a JSON array of `{ type, root }` somewhere outside the skill directory, list
**every** root you want because the file replaces the defaults rather than extending
them, then point `$SESSION_GREP_SOURCES_FILE` at it and confirm `origin=config`.

Set that variable in the host's own configuration, not a shell profile. An agent's
tool-shell frequently never sources a login profile, so an export in `~/.zshrc` is
simply absent and the search quietly falls back. In Claude Code the place is the `env`
block of `~/.claude/settings.json`. Other hosts have their own equivalent; a harness
that wraps this skill can pass `--sources-file` instead and skip the variable.

## Searching somewhere else

Four ways, in order of precedence:

1. `--root DIR` per call, no config; format auto-detected. Repeatable.
2. `--sources-file FILE` per call path to a JSON array of `{ type, root }`; use it when
   the directory does not reveal the parser type.
3. `$SESSION_GREP_SOURCES_FILE` env path to the same JSON array, for a global/npx
   install or CI.
4. Edit `DEFAULT_SOURCES` in `session-grep.mjs`. Only for a copy you own and update by
   hand. A skill installed globally is reinstalled in place by `npx skills update`, which
   overwrites this file and reverts the edit with no warning, after which searches use the
   defaults and look fine. Supporting a new tool is different: that is an adapter plus a
   line here, and belongs upstream in the repo rather than in one machine's copy.

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
