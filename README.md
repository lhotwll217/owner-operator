# Owner Operator

> **Status:** macOS only, and so far only tested with a Codex subscription driving the embedded
> Pi agent. Other model backends should work but are unverified. If you're interested in trying
> it, it is best you have both.

Agents are becoming capable of long-term work, and running many of them in parallel is now the
norm. For the first time, one person can manage multiple workstreams and converge on multiple
outcomes at once.

But this also creates new problems:

1. **Keeping track of multiple agents is hard.** The state of their work is spread across
   different threads and tools, which creates cognitive overload and friction. Understanding
   which agents need attention, what decisions need to be made, and whether work is converging
   on the intended outcomes becomes increasingly difficult. Things slip through the cracks, and
   valuable work stalls when an agent just needs a nudge.

2. **Valuable information is buried in threads and sessions.** It is isolated, noisy, and hard
   to locate. Each tool, each thread, becomes an information silo.

3. **Most harnesses want to lock you in.** Work should be as uncoupled from specific harnesses
   as possible. Core primitives like schedules, triggers, and loops should exist outside of any
   one product.

4. **Long-running threads get poisoned.** Context accumulates, the thread becomes biased, and
   there is no effective mechanism to pull the valuable work out and start fresh.

Sessions and threads are at the core of any agentic workflow. Take them away, and an agent
becomes an amnesiac. They hold all the history and context of work done and serve as an
incredibly detailed ledger of actions, reasoning, and outcomes. Never before has work been so
auditable.

Owner Operator builds on that ledger. It maintains a durable system of record of every session,
past and present, across every harness. Specialized tools search across all of it and pull the
signal from the noise.

The harness knows every running session at any point in time and assigns each a priority. A
floating widget keeps every session in view at all times, so nothing slips through the cracks.

The end goal is a harness fully aligned with the goal, task, and outcome of each thread, an
intelligent layer above them that helps you achieve optimal outcomes.

Today the widget is for live triage: read every coding-agent session in one place, rename a
thread, or mark it done without opening its harness. The Owner Operator agent can inspect durable
history and create prompt schedules that run in fresh isolated sessions.

## Who this is for

- Most of your agent work runs locally, on your own machine.
- You use more than one harness and want to keep it that way.
- You run many sessions at once and want to stay on top of all of them.

## Install

```bash
npm install            # once, from the repo root
./oo                   # guided first-run setup
```

Setup creates `~/.owner-operator/workspace`, asks which coding projects are off-limits, offers to
copy existing standalone Pi authorizations and model settings, then shows every supported harness
and recognized app or CLI on one review surface. Setup also asks whether shell commands and changes
should ask, run automatically, or remain unavailable. Standalone Pi is optional; fresh installs use
Owner Operator's built-in provider login and store credentials under `~/.owner-operator/pi`.
Harnesses start included; mark any to ignore. It then configures macOS always-on services, the
active window, and skills. The copy does not change standalone Pi. Until setup finishes, headless
calls and transcript/model processing fail closed.

`./oo doctor` (or `./oo status`) prints the effective home, workspace, task directory,
credentials/model source, transcript stores, session host roots, skills, tools, and permission mode without printing
secrets. Use `/permissions` to change the mode, `/permission-system show` to inspect the
composed Pi rules, or `/onboarding` to revisit setup.

## The widget

A floating macOS panel that always shows every session ranked by what needs you, so you can
see what's working, what's waiting, and what you left open. With the daemon running:

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

The terminal starts the background daemon when it needs state. Full flag, session, and
provenance reference: [docs/cli.md](docs/cli.md).

## The daemon

`oo daemon` is the long-lived local process hosting the state, session monitor, scheduler,
and loopback Gateway. Lifecycle, discovery, and LaunchAgents: [docs/daemon.md](docs/daemon.md).

## How it works

Built on the [pi coding agent](https://github.com/earendil-works/pi). Embedded Pi uses
Owner Operator-owned auth, model settings, workspace resources, and sessions under
`~/.owner-operator`; standalone Pi keeps its own defaults. Supported harnesses and their
transcript formats live in
[`AGENT_HARNESS_DESCRIPTORS`](packages/core/src/session-sources.mjs); apps and CLIs live
separately in [`SESSION_HOST_DESCRIPTORS`](packages/core/src/session-hosts.mjs).

Everything else lives next to what it documents:

- [docs/cli.md](docs/cli.md): driving `oo` headless, session provenance, model-free calls
- [docs/scheduler.md](docs/scheduler.md): durable prompt schedules and run history
- [docs/daemon.md](docs/daemon.md): daemon lifecycle and LaunchAgents
- [docs/architecture.md](docs/architecture.md): module ownership and boundaries
- [docs/testing.md](docs/testing.md): test tiers and the checks CI runs
