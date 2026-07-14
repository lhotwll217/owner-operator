---
title: "Architecture"
summary: "The code map: module ownership, dependency direction, state and events"
read_when:
  - Deciding where new code belongs
  - Tracing which module owns a behavior or boundary
---

# Architecture

Owner Operator is one local daemon with several clients. The daemon is a process boundary,
not a domain layer: it composes independent state, session-monitor, scheduler, and Gateway modules.

```text
widget · oo agent/tools · Pi extension · oo CLI
                      │
              Gateway (HTTP + SSE)
                      │
        ┌─────────────┼─────────────┐
 session monitor     state       scheduler
 scan + enrich    sole writer   Croner + runs
        │             │             │
 coding transcripts  SQLite    fresh Pi session / argv process
```

## Module ownership

| Module | Owns | Does not own |
|---|---|---|
| `packages/core` | Shared enums, types, pure state rules, wire contract, dependency-light filesystem config readers | SQLite, network, timers, processes, model calls |
| `src/state` | SQLite schema, transactions, projections, post-commit events, read-only query docs | Polling, HTTP, model calls |
| `src/session-monitor` | Transcript scan/watch and its private async enrichment worker | HTTP, scheduling |
| `src/scheduler` | Typed jobs, Croner calendar math, execution, run history, needs-you dedupe | HTTP, SQLite access outside `State` |
| `src/gateway` | Loopback HTTP/SSE translation and client SDK | SQLite, child processes, polling, model calls |
| `src/daemon` | Composition, process lifecycle, readiness, discovery, source fingerprint | Domain decisions |
| `src/agent` | Owned Pi runtime, onboarding, diagnostics, typed tools, Agent Skills, scheduled prompt runner, typed enrichment completion | Timers or direct SQLite |

Dependencies point toward the owning seam:

```text
core ← state ← { session-monitor, scheduler, gateway } ← daemon
core ← gateway client ← { agent, CLI, widget }
```

The Gateway server receives module interfaces from the daemon. It does not import the monitor or
scheduler implementations. `src/gateway/gateway.boundaries.test.ts` enforces that transport owns no
process/model runtime and that application code never loads from development-skill directories.

## State and events

SQLite (`~/.owner-operator/state.db`) is the only durable truth. `State` is its only production
writer. The active `/session-state` response is a projection over `threads` and the latest dense
`thread_details` version; there is no stored snapshot or embedded client store.

After a transaction commits, `State` publishes a rich typed event on a fail-isolated in-memory bus.
The bus wakes consumers; clients refetch truth rather than consuming event payloads. The Gateway maps domain events to three typed SSE
invalidations—state, schedule, or schedule-run changed—and clients refetch SQLite-backed truth.

Enrichment sends only bounded transcript samples to the model, read through
application-owned scan/search modules.
Enrichment is eligible when the current state is `needs-you` and `last_message_at` differs from
`enriched_through_message_at`. This catches first discovery, a new assistant message without a state
transition, and daemon restart. The monitor never awaits the model in its scan hot path.
The synchronous transcript parser and git inspection run in a child process, so reconciliation
cannot block Gateway health, SSE, or widget requests. Periodic scan failures are logged and retried
at the next normal reconciliation instead of becoming unhandled rejections; enrichment failures use
the same logged background seam and leave the durable watermark eligible for a later retry.

## Surface pages

Behavior lives with its surface; `npm run docs:list` prints every page with its
routing frontmatter.
