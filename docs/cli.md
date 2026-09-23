---
title: "oo CLI"
summary: "Reference for `oo`: grammar, operations, headless turns, and session provenance"
read_when:
  - Driving `oo` from a script or another agent
  - Looking up an `oo` operation, flag, or provenance rule
---

# `oo` CLI

`oo` is a Gateway client ([daemon.md](daemon.md)): every operation is a call to the running
daemon, which owns state, lifecycle, and child processes. The grammar lives in
[`src/cli/oo-args.ts`](../src/cli/oo-args.ts); operations live under
[`src/cli/operations/`](../src/cli/operations/).

## Grammar

| Invocation | What happens |
|---|---|
| `oo` | interactive session (embedded Pi); starts setup when needed |
| `oo -p "<prompt>"` / `--prompt` | one headless turn; prose on stdout, session id on stderr |
| `oo <noun> <verb> [args] [--json]` | model-free operation over the Gateway |
| `oo doctor` / `oo status` | effective harness configuration, no model call |
| `oo daemon` | the long-lived daemon process |
| `oo --help`, `oo <noun> --help`, `oo <noun> <verb> --help` | usage at each level |

A first token that is a reserved noun is an operation. Any other first token is an error that
prints usage and exits 2; there is no bare-prompt form. Removed spellings (`--session-state`,
`--done`, a top-level `--json`, the one-shot subcommand) exit 2 and name their replacement.

Operations print text by default and the route's payload with `--json`. Usage mistakes exit 2;
operation failures exit 1 and print the Gateway's error payload to stderr (as JSON under
`--json`).

## Operations

`oo <noun> --help` is the source of truth for each noun: verb nouns list their verbs, and
`oo <noun> <verb> --help` lists a verb's flags. `search` has no verbs; `oo search --help` prints the
search wrapper's own flags, which are its contract.

| Noun | Covers |
|---|---|
| `session-state` | current session rows (`GET /session-state`) and marking them done (`POST /done`) |
| `runs` | delegated runs. `delegate` launches through `POST /agent-runs` and streams the child to stdout until its terminal record (exit 0 only on `completed`); `--no-wait` prints the pending row. `logs [--follow] <id>` replays the run's event log and, with `--follow`, tails it like `docker logs -f`; Ctrl-C detaches without stopping the run. Text shows agent text and tool-call lines; `--json` emits NDJSON, one stored ACPX event per line then the result line. The parent is `--from-session`, else `OO_FROM_SESSION`/`CODEX_THREAD_ID`, else none. Model and effort resolve caller pin, then approved baseline, then the harness's choice ([delegated-runs.md](delegated-runs.md)) |
| `schedules` | durable schedules (`/schedules`); `create`/`update` read the `POST /schedules` body from `--from <file\|->`, so the schedule contract stays the Gateway's ([scheduler.md](scheduler.md)) |
| `harness` | one ephemeral harness-details snapshot (`POST /harness-details`); `--inspect <harness>:<model>[:<effort>]` confirms an exact identity, an omitted effort is null. It never carries delegated-baseline data ([delegated-runs.md](delegated-runs.md#harness-details)) |
| `search` | privacy-aware transcript search (`POST /session-search`); every argument except `--from-session` goes to the daemon's search wrapper, whose flags (`oo search --help`) and output are the contract. Blacklist, namespaces, and output bounds are enforced in the daemon |
| `skill` | the outside-agent skill [`skills/owner-operator`](../skills/owner-operator/SKILL.md). `install` links it as `npx skills add` does: `~/.agents/skills/owner-operator` points into this checkout, and every existing Claude Code, Codex, and Cursor skills folder gets a link to that, each reported linked or skipped; a copied `owner-operator` skill is moved to `$OO_HOME/skill-backups/`. `uninstall` removes only links `install` created; `status` (also in `oo doctor`) shows each link's target and flags dangling links. Run it from the durable checkout: `git pull` then updates the skill with no further command. The product agent never loads this skill |
| `db` | read-only SQL over the state database (`POST /query-database`); `describe` shows [schema docs](../src/state/schema-docs.ts) |

`session-state done` takes explicit ids only, from `session-state list`, with no environment
guessing, so parallel agents in one repo cannot mark each other. A harness that knows its own
session id (e.g. a session-end hook) can self-mark.

## Interactive tool display

The pinned `pi-tool-display` extension owns compact OpenCode-style calls and results for Pi's
built-ins and Owner Operator's custom tools. Pi's expansion key (`Ctrl+O` by default) reveals the
raw result; Owner Operator does not add a second folding or replay layer. The native user-message
box is disabled, while the Owner Operator theme, marker, and delegated-run
launch/completion lifecycle rows remain separate product presentation.

## Sessions and provenance

Every oo chat, human or agent, is saved under `~/.owner-operator/sessions`,
never mixed with coding sessions, and labeled with its surface and caller repo.

- `--continue` / `-c` resumes the most recent oo thread; `--session <id-or-path>`
  resumes a specific one. With `-p` the resumed thread takes one headless turn; without it,
  the plain readline REPL opens on that thread.
- A root with a selected OO worktree resumes with its tools bound to that exact path, including
  after CLI or daemon restart. Invalid selections fail visibly instead of falling back to the
  checkout running OO; roots without a selection keep the invocation cwd.
- Agents pass `--from-session <id>` (or `OO_FROM_SESSION`) so the audit trail
  records who called. Codex callers are detected from `CODEX_THREAD_ID`.
- Open-ended transcript discovery excludes both the current oo thread and its external
  coding-session caller; explicit stable-ID retrieval remains available.
- Transcript discovery searches configured coding history and oo's saved conversations by
  default while retaining their source namespaces. `--owner-operator` narrows to oo history.
