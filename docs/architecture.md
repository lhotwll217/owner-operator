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
| `packages/core` | Shared enums, types, pure state rules, wire contract | I/O, timers, processes |
| `src/state` | SQLite schema, transactions, projections, post-commit events, read-only query docs | Polling, HTTP, model calls |
| `src/session-monitor` | Transcript scan/watch and its private async enrichment worker | HTTP, scheduling |
| `src/scheduler` | Typed jobs, Croner calendar math, execution, run history, needs-you dedupe | HTTP, SQLite access outside `State` |
| `src/gateway` | Loopback HTTP/SSE translation and client SDK | SQLite, child processes, polling, model calls |
| `src/daemon` | Composition, process lifecycle, readiness, discovery, source fingerprint | Domain decisions |
| `src/agent` | Pi session factory, typed tools, scheduled prompt runner, typed enrichment completion | Timers or direct SQLite |
| `src/session-search` | Privacy-aware transcript search wrapper | Durable state |
| `vendor/session-grep` | Pinned upstream search primitive | Owner Operator policy |

Dependencies point toward the owning seam:

```text
core ← state ← { session-monitor, scheduler, gateway } ← daemon
core ← gateway client ← { agent, CLI, widget }
```

The Gateway server receives module interfaces from the daemon. It does not import the monitor or
scheduler implementations. `src/gateway/gateway.boundaries.test.ts` enforces that transport owns no
process/model runtime and that skill directories contain no application code.

## State and events

SQLite (`~/.owner-operator/state.db`) is the only durable truth. `State` is its only production
writer. The active `/session-state` response is a projection over `threads` and the latest dense
`thread_details` version; there is no stored snapshot or embedded client store.

After a transaction commits, `State` publishes a rich typed event on a fail-isolated in-memory bus.
The bus is a wake-up mechanism, never a queue. The Gateway maps domain events to three typed SSE
invalidations—state, schedule, or schedule-run changed—and clients refetch SQLite-backed truth.

Enrichment is eligible when the current state is `needs-you` and `last_message_at` differs from
`enriched_through_message_at`. This catches first discovery, a new assistant message without a state
transition, and daemon restart. The monitor never awaits the model in its scan hot path.

## Scheduler

One daemon scheduler replaces the former Gateway shell runner and the independent
`pi-schedule-prompt` timer. The typed vocabulary is:

- Trigger: `at`, `every`, `cron` with an explicit IANA time zone, or `needs-you`.
- Payload: `prompt` or direct `argv` command.
- Prompt tools: concrete `AgentToolId[]`; presets are resolved upstream.
- Run context: absolute `cwd`, timeout, immutable payload snapshot, and trigger context.

Cron evaluation uses pinned `croner@10.0.1`, following OpenClaw's proven
[Croner adapter](https://github.com/openclaw/openclaw/blob/372b527da4a1cee5b819e7852f6e26ef11160e85/src/cron/schedule.ts#L1-L55).
Our small public scheduler seam mirrors OpenClaw's explicit
[cron service contract](https://github.com/openclaw/openclaw/blob/372b527da4a1cee5b819e7852f6e26ef11160e85/src/cron/service-contract.ts#L27-L45)
without copying its product-specific delivery system.

Prompt runs create a fresh Pi `SessionManager` and transcript under
`~/.owner-operator/sessions`; `oo-provenance` records job/run identity. This follows OpenClaw's
isolated-job rule: [a new transcript/session id per run](https://github.com/openclaw/openclaw/blob/372b527da4a1cee5b819e7852f6e26ef11160e85/docs/automation/cron-jobs.md#L203-L220).
Commands execute exact `argv` without a shell unless an explicitly migrated caller supplies
`["/bin/sh", "-lc", command]`.

Scheduler policy:

- Global concurrency starts at one; the same job never overlaps.
- Overdue one-shots run once. Recurring jobs skip backlog and record timing/missed counts in run context.
- A daemon crash marks running rows `interrupted`; no automatic job retry occurs.
- Commands and prompt runs have bounded timeouts and bounded stdout/stderr tails.
- Disabling/deleting prevents future triggers but does not cancel an active run.
- A monotonic schedule revision prevents an active run from overwriting a concurrent edit.
- Needs-you changes batch once per reconciliation; run creation and per-thread watermarks commit atomically.

Users inspect `schedules` and `schedule_runs` through the existing read-only `query_database` tool.
The table intent and columns live once in `src/state/schema-docs.ts`.

## Daemon and clients

The daemon binds only `127.0.0.1`. `/health` reports PID, start time, fingerprint, and staleness;
`/ready` reports module initialization. Clients require readiness. Production clients never open
SQLite and there is no `OO_DAEMON=0` mode.

The runtime fingerprint hashes `src`, `packages/core`, package metadata, and Pi settings, including
uncommitted changes. A mismatch marks the daemon stale and exits it gracefully; launchd or the
terminal ensure path starts the current runtime. This adapts OpenClaw's installed service-version
stamp ([source](https://github.com/openclaw/openclaw/blob/372b527da4a1cee5b819e7852f6e26ef11160e85/src/daemon/service-env.ts#L430-L446))
to a development checkout where source content—not package version—is authoritative.

The widget installer installs both LaunchAgents. The widget itself remains a pure Gateway client
and never spawns a process. Showing Owner Operator's own scheduled sessions in the widget is a
separate feature; those transcripts are searchable now but excluded from external coding-session
monitoring, preventing automation loops.

## V0 cutover

There are no downstream consumers. The old `threads.db`, JSON snapshot, embedded fallback,
Gateway-owned poll/scheduler, skill runtime, shell schedule shape, and compatibility migrations are
intentionally not carried forward. V0 starts with `state.db` and one canonical runtime.
