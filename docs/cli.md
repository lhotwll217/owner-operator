---
title: "oo CLI"
summary: "Reference for `oo`: modes, flags, session provenance, and model-free calls"
read_when:
  - Driving `oo` from a script or another agent
  - Looking up an `oo` flag, subcommand, or provenance rule
---

# `oo` CLI

`oo` is one command. Anything that is not a recognized flag or subcommand is the
prompt, so `oo what changed --since today` asks the model instead of erroring on
an unknown flag. The recognized set lives in
[`src/cli/oo-args.ts`](../src/cli/oo-args.ts).

## Modes

| Invocation | What happens |
|---|---|
| `oo` | interactive session (embedded Pi); starts setup when needed |
| `oo "<prompt>"` | headless single turn; prose on stdout, session id on stderr |
| `oo -i` / `--interactive` | force interactive |
| `oo doctor` / `oo status` | effective harness configuration, no model call |
| `oo daemon` | the long-lived daemon process: [daemon.md](daemon.md) |
| `oo --help` / `-h` | usage |

`--json` and one-shot spellings are rejected with guidance instead of being treated as a
prompt.

## Sessions and provenance

Every oo chat, human or agent, is saved under `~/.owner-operator/sessions`,
never mixed with coding sessions, and labeled with its surface and caller repo.

- `--continue` / `-c` resumes the most recent oo thread; `--session <id-or-path>`
  resumes a specific one.
- Agents pass `--from-session <id>` (or `OO_FROM_SESSION`) so the audit trail
  records who called. Codex callers are detected from `CODEX_THREAD_ID`.
- Transcript discovery excludes the caller's own session, so a caller never
  retrieves its own prompt as evidence.
- oo's saved conversations stay out of default coding-session search; the
  session-search skill reaches them only through its explicit `--owner-operator`
  scope.

## Model-free calls

For scripts and agents that need state without a model call:

- `oo --session-state` prints the current state rows as JSON.
- `oo --done <id...>` marks threads done. Ids come from `--session-state` and are
  explicit only, with no environment guessing, so parallel agents in one repo
  cannot mark each other. A harness that knows its own session id (e.g. a session-end
  hook) can self-mark.
