# Architecture (provisional)

> First-cut sketch. Everything here is intentionally light — see [VISION.md](../VISION.md)
> for the why. This document will firm up as the PI harness lands.

## Shape

```
            ┌──────────────────────────────────────────────────────────┐
            │                      SURFACES                            │
            │   macOS widget  (glance)        localhost web (drill-in) │
            └───────────────▲───────────────────────────▲──────────────┘
                            │  high-signal, low-noise    │  read-first
                            │  prioritized leaves        │  session detail
            ┌───────────────┴───────────────────────────┴──────────────┐
            │                   HARNESS "PI"  (local)                   │
            │   strict command set · triage/priority · scheduling       │
            │   "monitor the situation"  ·  deterministic workflows     │
            └───────────────▲───────────────────────────▲──────────────┘
                            │                           │
              ┌─────────────┴─────────────┐   ┌─────────┴───────────────┐
              │  scan/grep skills (ours)  │   │  signal (later: V3)     │
              │  over local session files │   │  PRs/MRs, Slack,        │
              │  Claude Code, Codex       │   │  email, calendar        │
              └───────────────────────────┘   └─────────────────────────┘
```

## Component responsibilities

- **Harness "PI"** (`harness/`) — the brain. Reads sessions, computes triage/priority,
  runs on a schedule to "monitor the situation," and exposes a **strict, enumerated
  command set** (no open-ended driving of sub-agents). Deterministic workflow scripts
  live alongside it for the repeatable stuff.
- **daemon** (`harness/src/daemon.ts`) — the state owner, openclaw's gateway pattern
  local-first: ONE process runs the poll loop (scan → canonical resolver → store), the
  schedule/trigger runner, and an HTTP + SSE server on 127.0.0.1. Surfaces are thin
  clients over the protocol in `packages/core` (`oo daemon` to run; the TUI auto-spawns
  it and falls back to an embedded poller when disabled via `OO_DAEMON=0`).
- **core** (`packages/core/`) — the shared types the surfaces and harness agree on
  (sessions, threads, priority). Deliberately thin until we build — not a committed
  schema. Keeps everything speaking one language.
- **workflows** (`packages/workflows/`) — deterministic scripts the harness can invoke
  (e.g. "summarize today's threads," "flag stale branches"). Predictable, testable,
  not model-improvised.
- **widget** (`apps/widget/`) — glance surface. Renders prioritized leaves; lets you
  drop a prompt to the right agent.
- **web** (`apps/web/`) — drill-in surface. Read-first; shows a session exactly where it
  left off.

## Key design constraints

1. **The harness reads and triages; it does not author work in branches.** Writing a
   prompt drills you straight into the target session — your words, unmediated.
2. **Strict command set.** The harness exposes a bounded vocabulary of actions, not a
   free-form agent loop, so behavior stays legible and safe.
3. **Concise.** Surfaces show the current state of each thread, not transcripts. Depth
   is one drill away.

## Triage

The operator's value is ordering threads so the next thing to touch is obvious — by
urgency and by how much attention each needs (a one-tap "merge it" vs. a plan that wants
real review). The exact ranking model is TBD; we'll learn it by using it, not design it
up front.

## Schedules & triggers

The daemon hosts them (see `packages/core/src/protocol.ts` for shapes): a schedule is
WHEN × ACTION, upserted by name over HTTP. `interval`/`daily` run from the tick loop;
`event: needs-you` fires when a thread newly needs the owner (with
`OO_NEEDS_YOU=<ids>` in the env). Actions today: `poll` and `shell` — a desktop
notification or a piped `oo --json` brief is one shell command away; a model-driven
brief becomes a new action type when it's ready.

```sh
curl -X PUT localhost:47711/schedules/morning-brief \
  -d '{"when":{"type":"daily","at":"08:00"},"action":{"type":"shell","command":"oo --json \"what needs me\" > ~/brief.json"}}'
curl -X PUT localhost:47711/schedules/notify \
  -d '{"when":{"type":"event","event":"needs-you"},"action":{"type":"shell","command":"osascript -e \"display notification \\\"$OO_NEEDS_YOU\\\" with title \\\"oo\\\"\""}}'
```

## Open questions

- Monorepo tooling (workspaces / task runner) — deferred until there's code to build.
- ~~How the widget authenticates/talks to the local harness~~ — answered: the daemon's
  localhost HTTP + SSE (no auth while loopback-only; revisit before any non-local bind).
- Phone/diff-review UX (V3): draft PRs vs. native inline-comment-tied-to-line.
