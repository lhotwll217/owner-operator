# Owner Operator

> **Status:** macOS only. A Codex subscription is the only tested model backend; others are
> unverified. If you're trying it, it is best you have both.

Owner Operator is an agent that helps you track and manage work across all your local coding
agents. The harness operates a state machine that tracks ongoing agent sessions and their
current status: working, waiting, or stale. It also generates summaries, so you can quickly see
actionable details. Together these act as a high-signal ledger that lets the agent quickly
understand how work has evolved through a session. All of this is viewable from a persistent
widget that surfaces the list of ongoing sessions. The goal is to increase visibility while
promoting the most actionable information.

A core capability is searching and finding context across **all** sessions, independent of
which harness created them. This is built on
[session-grep](https://github.com/lhotwll217/session-grep), which can also be used as a
standalone skill if you want session search directly in Claude Code, Codex, or any other
harness. The harness maintains a directory of session folders, organized by project/repo.

The agent can also delegate work to other coding harnesses. Today Claude Code, Codex, and the
Cursor CLI are supported, but the idea is to support any harness that implements the ACP
protocol. This lets
the Owner Operator agent oversee a large piece of work while preserving the overall goal and
adhering to the standards set by you. This approach is best coupled with an opinionated
workflow via skills — I use Matt Pocock's skills, for example.

Some core principles drive the design and features of this harness:

1. **Sessions are the ultimate source of truth** for the work your agents do, and should be
   leveraged as such.
2. **Context is everything.** Sessions are easily poisoned and immediately become biased. We
   want to keep sessions in the
   [smart zone](https://www.aihero.dev/ai-coding-dictionary/smart-zone).
3. **The more harness-agnostic your workflows are, the better.** Which coding agent actually
   implements the work should be as trivial a detail as possible.

## Who this is for

- Most of your agent work runs locally, on your own machine.
- You use more than one harness and want to keep it that way.
- You run many sessions at once and want to stay on top of all of them.

## Install

```bash
npm install            # once, from the repo root; needs Node 22+
./oo                   # guided first-run setup
```

Setup walks privacy boundaries, credentials, the supported-harness review, permission mode,
and macOS always-on services: [docs/onboarding.md](docs/onboarding.md).

## Talking to the agent

You talk to Owner Operator through `oo`, a terminal agent. Run `oo` for an interactive
session; `--continue` picks up your most recent thread. For example:

- "Give me a breakdown of all the projects we worked on last week — any loose ends we need
  to tie up?"
- "This claude code session is going in circles, give me a prompt to course-correct it."
- "Implement gh issue #4 and delegate it to codex; break the work into separate agents if
  needed, and fire off a claude fable review agent for the overall work."

## Harness-to-harness interaction

As Owner Operator can drill down into other sessions, other harness agents can also "drill
up" and get context from Owner Operator and even invoke its native tooling. Think of it like
an IC referring to a manager for context. Any coding agent can shell out to `oo` for a
headless turn, or invoke certain tools directly — `oo --session-state`, for example, prints
the current session rows as JSON with no model call. Flags and rules:
[docs/cli.md](docs/cli.md).

## The widget

A floating macOS panel that shows your sessions, the ones needing attention first, so you can
see what's working, what's waiting, and what you left open. With the daemon running:

```bash
cd apps/widget && make run
```

Behavior and boundaries: [docs/widget.md](docs/widget.md).

## The daemon

`oo daemon` is the long-lived local process hosting the state, session monitor, scheduler,
and loopback Gateway. Lifecycle, discovery, and LaunchAgents: [docs/daemon.md](docs/daemon.md).

## How it works

Built on the [pi coding agent](https://github.com/earendil-works/pi); how Owner Operator
uses it is [docs/agent.md](docs/agent.md). Every surface has its own page in
[docs/](docs/):

```sh
npm run docs:list      # every page with its summary and read-when hints
```
