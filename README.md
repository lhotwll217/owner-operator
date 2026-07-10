# Owner Operator

You run coding agents in parallel across several tools and lose track of what each one is
doing. Owner Operator pulls every session onto one surface, ranked by what needs you, so you
can see them all at once and drop into the right one.

Today the widget is for live triage: read every coding-agent session in one place, rename a
thread, or mark it done without opening its harness. The Owner Operator agent can inspect durable
history and create prompt schedules that run in fresh isolated sessions.

## Install

```bash
npm install            # once, from the repo root
```

## The widget

The main surface: a floating macOS panel that always shows every session ranked by what needs
you, so you can see what's working, what's waiting, and what you left open. With the daemon
running:

```bash
cd apps/widget && make run
```

## The terminal

```bash
./oo                   # pi's stock interactive mode
./oo "what's ongoing?" # headless single-turn question, prose on stdout
./oo --continue "more" # resume the most recent oo thread
./oo --session-state   # current widget/gateway state, no model call
```

The terminal starts the background daemon when it needs state. The widget is the always-on UI
surface for the ranked session list.

## The daemon

`oo daemon` is the long-lived local process hosting the state, session monitor, scheduler,
and loopback Gateway. Terminal clients ensure the current daemon is ready. The widget installer
installs daemon + widget LaunchAgents together; the widget itself never spawns processes.

## How it works

Built on the [pi coding agent](https://github.com/earendil-works/pi). `oo` reads session
files through application-owned scan/search modules and only sends bounded transcript samples to
the model. Supported agents live in
[`KNOWN_SESSION_SOURCES`](packages/core/src/session-sources.mjs). Agents drive it headless
with `oo "question"`: a single turn that prints its session id on stderr, with `--continue`
/ `--session <id>` resuming that thread on the next call. Every oo chat, human or agent, is
saved under `~/.owner-operator/sessions` (never mixed with your coding sessions), labeled
with its surface and caller repo; agents pass `--from-session <id>` so the audit trail
records who called.

Model-free calls for scripts and agents: `oo --session-state` prints the current state
rows as JSON, and `oo --done <id...>` marks threads done (ids come from `--session-state`;
explicit only — no environment guessing, so parallel agents in one repo can't mark each
other). A coding harness that knows its own session id (e.g. a session-end hook) can
self-mark with `oo --done <that id>`.

Durable prompt schedules use the typed `schedule_prompt` tool. Each run gets a fresh isolated
Owner Operator transcript; failures and output are inspectable through `query_database` over
`schedules` and `schedule_runs`.

So far this has only been tested with a Codex subscription as the driver for the pi agent.
Other model backends should work but are unverified.

Architecture: [docs/architecture.md](docs/architecture.md). Contributing (workflow, checks,
standards): [CONTRIBUTING.md](CONTRIBUTING.md).
