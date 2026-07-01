# Architecture

## Shape

```
        ┌──────────────────────────────────────────────────────────────┐
        │  UIs:  terminal (oo)  ·  macOS widget  ·  web (not built)      │
        └───────────────────────────▲──────────────────────────────────┘
        ┌───────────────────────────┴──────────────────────────────────┐
        │                    HARNESS "PI"  (local)                      │
        │       reads sessions · ranks them · runs on a schedule        │
        └───────────────────────────▲──────────────────────────────────┘
                                    │
                    ┌───────────────┴────────────────┐
                    │  scan/grep skills (ours) over   │
                    │  local session files            │
                    └────────────────────────────────┘
```

## What each part does

- **Harness "PI"** (`harness/`) — reads local agent sessions, ranks them by what needs you,
  runs on a schedule. Exposes a fixed set of commands, not a free-form agent loop.
- **daemon** (`harness/src/daemon.ts`) — one local process that owns the state: runs the
  poll loop (scan → resolve thread state → store), runs schedules/triggers, and serves
  HTTP + SSE on 127.0.0.1. The UIs are thin clients over the protocol in `packages/core`.
  `oo daemon` to run; the TUI auto-spawns it and falls back to an in-process poller when
  disabled (`OO_DAEMON=0`).
- **core** (`packages/core/`) — the shared types the harness and UIs agree on (sessions,
  threads, priority).
- **workflows** (`packages/workflows/`) — *not built yet.* Deterministic scripts the harness
  will run (e.g. "summarize today's threads").
- **widget** (`apps/widget/`) — macOS app showing the ranked thread list. Reads from the daemon.
- **web** (`apps/web/`) — *not built yet.* localhost page to open one session and read it.

## Rules

1. The harness only reads — it never writes into your sessions.
2. It runs a fixed set of commands, not an open-ended agent loop.
3. The UIs show the current state of each thread, not full transcripts.

## Ranking

The point is ordering threads so the next one to open is obvious — by urgency and by how
much attention it needs (a one-tap "merge it" vs. a plan that wants review). The exact model
is TBD; we'll learn it by using it.

## Schedules & triggers

The daemon runs them (shapes in `packages/core/src/protocol.ts`): a schedule is WHEN ×
ACTION, set by name over HTTP. `interval`/`daily` run from the tick loop; `event: needs-you`
fires when a thread newly needs you (`OO_NEEDS_YOU=<ids>` in the env). Actions today: `poll`
and `shell` — so a desktop notification or a piped `oo --json` brief is one shell command.

```sh
curl -X PUT localhost:47711/schedules/morning-brief \
  -d '{"when":{"type":"daily","at":"08:00"},"action":{"type":"shell","command":"oo --json \"what needs me\" > ~/brief.json"}}'
```
