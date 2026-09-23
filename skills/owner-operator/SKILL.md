---
name: owner-operator
description: The `oo` CLI for Owner Operator, the local chief of staff over every coding-agent session on this machine. Use it to read the state of the owner's other sessions, search their transcripts, ask Owner Operator a question in a fresh session uncolored by this thread, or hand work to a daemon-owned child agent and stream its output.
---

# Owner Operator (`oo`)

`oo` talks to the Owner Operator daemon on this machine. The daemon owns all state and every
child process; `oo` starts it when needed.

## When to reach for it

- **Cross-session state**: what the owner's other agent sessions are doing, what needs them,
  what a session said or decided.
- **An outside read**: `oo -p "<question>"` answers in a fresh Owner Operator session, so its
  view is not shaped by this conversation.
- **Delegation**: a task for another harness (Claude Code, Codex, Cursor, OpenCode) that should
  run as its own tracked session.

## Say who is calling

Pass `--from-session <your session id>` on every call that accepts it, or export
`OO_FROM_SESSION` once. Owner Operator records it as provenance, excludes your own transcript from
searches, and records your session as the parent of runs you delegate. Codex sessions are
identified automatically.

## Operations

`oo <noun> <verb>` operations make no model call. `oo --help` lists the nouns;
`oo <noun> --help` lists that noun's verbs and flags. Add `--json` for machine-readable output.

## Delegating

`oo runs delegate --harness <harness> "<task>"` launches the child and streams its output to
stdout until it finishes; the exit code is 0 only when the run completed. The daemon owns the
child, so to run it in the background use `--no-wait`, which prints the run row immediately, then
`oo runs logs --follow <id>` to attach. Interrupting either command detaches without stopping the
run, and `logs --follow` replays from the start when you reattach.
