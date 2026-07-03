# Owner Operator

You run coding agents in parallel across several tools and lose track of what each one is
doing. Owner Operator pulls every session onto one surface, ranked by what needs you, so you
can see them all at once and drop into the right one.

Today it's for reading: one place to see the state of all your coding-agent sessions without
opening each one.

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

## The terminals

Two terminal UIs on the same agent core, both for working across sessions: ask what's going
on, pull context from several coding sessions at once, then drop into the right one.

```bash
./harness/oo           # branded TUI: chat with your session list pinned beside it
./harness/oo -i        # pi's stock chat, wired to our session cards and slash commands
```

Either one starts the background daemon.

## The daemon

`oo daemon` watches your sessions and serves both UIs. The terminals start it automatically;
run it yourself when you only want the widget.

## How it works

Built on the [pi coding agent](https://github.com/earendil-works/pi). `oo` reads session files
off disk with small scan/grep skills ([.agents/skills](.agents/skills/)) and never loads full
transcripts into a model. Supported agents live in
[`KNOWN_SESSION_SOURCES`](packages/core/src/session-sources.mjs). Agents can drive it headless:
`oo one-shot "question"` for a single read-only turn — it prints its session id on stderr, and
`--continue` / `--session <id>` resume that thread on the next call — or `oo --rpc` for a
persistent JSON-RPC channel. Every oo chat, human or agent, is saved under
`~/.owner-operator/sessions` (never mixed with your coding sessions), labeled with its surface
and caller repo; agents pass `--from-session <id>` so the audit trail records who called.

So far this has only been tested with a Codex subscription as the driver for the pi harness.
Other model backends should work but are unverified.

Architecture: [docs/architecture.md](docs/architecture.md).
