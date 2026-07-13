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
./oo                   # guided first-run setup
```

Setup creates `~/.owner-operator/workspace`, asks which coding projects are off-limits, offers to
copy existing standalone Pi authorizations and model settings, then shows every supported harness
and recognized app or CLI on one review surface. Standalone Pi is optional; fresh installs use
Owner Operator's built-in provider login and store credentials under `~/.owner-operator/pi`.
Harnesses start included; mark any to ignore. It then configures macOS always-on services, the
active window, and skills. The copy does not change standalone Pi. Until setup finishes, headless
calls and transcript/model processing fail closed.

`./oo doctor` (or `./oo status`) prints the effective home, workspace, task directory,
credentials/model source, transcript stores, session host roots, skills, tools, and permission gates without printing
secrets. Re-run `/onboarding` in the interactive terminal to change setup choices.

## The widget

The main surface: a floating macOS panel that always shows every session ranked by what needs
you, so you can see what's working, what's waiting, and what you left open. With the daemon
running:

```bash
cd apps/widget && make run
```

## The terminal

```bash
./oo                   # embedded Pi interactive mode; starts setup when needed
./oo "what's ongoing?" # headless single-turn question, prose on stdout
./oo --continue "more" # resume the most recent oo thread
./oo --session-state   # current widget/gateway state, no model call
./oo doctor            # effective harness configuration, no model call
```

The terminal starts the background daemon when it needs state. The widget is the always-on UI
surface for the ranked session list.

## The daemon

`oo daemon` is the long-lived local process hosting the state, session monitor, scheduler,
and loopback Gateway. Terminal clients ensure the current daemon is ready. The widget installer
installs daemon + widget LaunchAgents together; the widget itself never spawns processes.

## How it works

Built on the [pi coding agent](https://github.com/earendil-works/pi). Embedded Pi uses
Owner Operator-owned auth, model settings, workspace resources, and sessions under
`~/.owner-operator`; standalone Pi keeps its own defaults. `oo` reads session
files through application-owned scan/search modules and only sends bounded transcript samples to
the model. Supported harnesses and their transcript formats live in
[`AGENT_HARNESS_DESCRIPTORS`](packages/core/src/session-sources.mjs); apps and CLIs live separately
in [`SESSION_HOST_DESCRIPTORS`](packages/core/src/session-hosts.mjs). Agents drive it headless
with `oo "question"`: a single turn that prints its session id on stderr, with `--continue`
/ `--session <id>` resuming that thread on the next call. Every oo chat, human or agent, is
saved under `~/.owner-operator/sessions` (never mixed with your coding sessions), labeled
with its surface and caller repo; agents pass `--from-session <id>` so the audit trail
records who called. Codex callers are detected from `CODEX_THREAD_ID`; other harnesses pass
`--from-session` or `OO_FROM_SESSION`. Transcript discovery excludes that caller session to
avoid prompt-echo retrieval. Owner Operator's own saved conversations remain outside normal
coding-session search and are searched only through the explicit `--owner-operator` scope.

Model-free calls for scripts and agents: `oo --session-state` prints the current state
rows as JSON, and `oo --done <id...>` marks threads done (ids come from `--session-state`;
explicit only — no environment guessing, so parallel agents in one repo can't mark each
other). A coding harness that knows its own session id (e.g. a session-end hook) can
self-mark with `oo --done <that id>`.

Durable prompt schedules use the typed `schedule_prompt` tool. Each run gets a fresh isolated
Owner Operator transcript; failures and output are inspectable through `query_database` over
`schedules` and `schedule_runs`.

So far this has only been tested with a Codex subscription as the driver for the embedded Pi
agent. Other model backends should work but are unverified.

Architecture: [docs/architecture.md](docs/architecture.md). Contributing (workflow, checks,
standards): [CONTRIBUTING.md](CONTRIBUTING.md).
