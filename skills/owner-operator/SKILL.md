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

## Find the session first

To find which session handled something, `oo db query` with a `LIKE` on `thread_details.topic`
and `status_summary` (every session's titles and status-summary history) before searching
transcripts, then `oo search --skim` the ids it returns.

## Start at `oo --help`

Run `oo --help` first. It routes each question to a noun and says how to identify your session.
Then read `oo <noun> --help` and `oo <noun> <verb> --help` before running a verb: each one
carries that command's rules, what to do next, and examples. The help is the guidance, the same
text Owner Operator's own agent works from.
