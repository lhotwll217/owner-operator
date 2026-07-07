# Architecture

## Shape

```
        ┌──────────────────────────────────────────────────────────────┐
        │  UIs:  macOS widget  ·  terminal (oo)  ·  web (not built)      │
        └───────────────────────────▲──────────────────────────────────┘
        ┌───────────────────────────┴──────────────────────────────────┐
        │                 GATEWAY  (local, always-on)                   │
        │       reads sessions · owns state · runs schedules            │
        └───────────────────────────▲──────────────────────────────────┘
                                    │
                    ┌───────────────┴────────────────┐
                    │  scan/grep skills (ours) over   │
                    │  local session files            │
                    └────────────────────────────────┘
```

## What each part does

- **gateway** (`src/gateway/`) — one local process (`oo daemon`) that owns state: runs
  the poll loop (scan → resolve thread state → store), runs schedules/triggers, and serves
  HTTP + SSE on 127.0.0.1. The widget, terminal, and session-state callers are thin clients over the
  protocol in `packages/core`.
- **agent** (`src/agent/`) — the pi-based Operator session config: prompt, tools, model
  settings, and saved-session provenance (the repo's `.agents/skills` are not injected —
  the Operator's interface to them is its typed tools). It is a gateway client.
- **CLI** (`src/cli/`) — terminal entrypoints: pi interactive mode for humans and headless
  single-turn calls for agents.
- **core** (`packages/core/`) — the shared types every surface agrees on (sessions, threads,
  priority, state rows).
- **workflows** (`packages/workflows/`) — *not built yet.* Deterministic scripts that run
  against the gateway/skills (e.g. "summarize today's threads").
- **widget** (`apps/widget/`) — macOS app showing the ranked thread list. Reads from the daemon.
- **web** (`apps/web/`) — *not built yet.* localhost page to open one session and read it.

## Layout & the dependency rule

The gateway is a top-level component at root `src/gateway/` — OpenClaw's layout: the root
package is the product, the gateway is primary, and every surface is a client. Dependencies
point toward state ownership, never back out to agent/UI code (see
[inspiration.md](inspiration.md)):

```text
core (packages/core) ← gateway (src/gateway) ← { src/agent, src/cli, widget, web }
```

- `src/gateway/` — daemon, poller, store, threads-db, and the `Backend` client seam.
  Model-free and agent-free; [#14](https://github.com/lhotwll217/owner-operator/issues/14)'s
  arrow. Enforced by `src/gateway/gateway.boundaries.test.ts`, so CI fails on a leak.
- `src/agent/` — the pi-based Operator; a client of the gateway like every surface.
- `src/cli/` — terminal entrypoints only; no state ownership.
- `src/prompts/` — Operator prompt text loaded by the agent core.
- `src/shared/` — root-local utilities shared by the agent and CLI.
- `eval/` — promptfoo harness proving OO's composition against a naive-baseline ablation
  (both arms same `oo`/model, one variable) over synthetic fixtures. See
  [eval/README.md](../eval/README.md).

## Rules

1. It runs a fixed set of commands, not an open-ended agent loop.
2. The UIs show the current state of each thread, not full transcripts.
3. Dependencies point inward — `src/gateway/` imports only core and node/runtime APIs.

## Ranking

The point is ordering threads so the next one to open is obvious — by urgency and by how
much attention it needs (a one-tap "merge it" vs. a plan that wants review). The exact model
is TBD; we'll learn it by using it.

## Schedules & triggers

The daemon runs them (shapes in `packages/core/src/protocol.ts`): a schedule is WHEN ×
ACTION, set by name over HTTP. `interval`/`daily` run from the tick loop; `event: needs-you`
fires when a thread newly needs you (`OO_NEEDS_YOU=<ids>` in the env). Actions today: `poll`
and `shell` — so a desktop notification or a piped `oo --session-state` brief is one shell command.

```sh
curl -X PUT localhost:47711/schedules/morning-brief \
  -d '{"when":{"type":"daily","at":"08:00"},"action":{"type":"shell","command":"oo --session-state > ~/brief.json"}}'
```

In the agent surfaces, scheduling is session-level via the
[pi-schedule-prompt](https://pi.dev/packages/pi-schedule-prompt) package (installed through
`.pi/settings.json` `packages`): the owner tells the Operator "re-triage every 15 minutes"
or "remind me at 3pm" and it schedules a prompt to itself with the `schedule_prompt` tool.
Jobs only fire while a session is open — the daemon's schedules are the always-on layer.
