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
| `src/agent` | Pi session factory, typed tools, Agent Skills, scheduled prompt runner, typed enrichment completion | Timers or direct SQLite |

Dependencies point toward the owning seam:

```text
core ← state ← { session-monitor, scheduler, gateway } ← daemon
core ← gateway client ← { agent, CLI, widget }
```

The Gateway server receives module interfaces from the daemon. It does not import the monitor or
scheduler implementations. `src/gateway/gateway.boundaries.test.ts` enforces that transport owns no
process/model runtime and that application code never loads from development-skill directories.

## Agent capabilities

- **Tools** are executable, typed Pi capabilities defined under `src/agent/tools`; same-name
  safety overrides for Pi file/bash primitives live at the Agent boundary. Explicitly enabled
  `edit` and `write` tools enforce the same blacklist, including symlinked parent directories.
- **Skills** are standard Agent Skills under `src/agent/skills`; each `SKILL.md` may bundle the
  scripts and private vendored dependencies needed to follow its workflow.
- `session-search` is such a skill: Pi's native `bash` invokes its policy wrapper, which executes
  the pinned upstream `session-grep` CLI. The wrapper—not application runtime code—owns local
  source mapping, blacklist policy, and the decision to exclude the caller during discovery.
  Caller identity comes from provenance. Owner Operator's own saved conversations remain a
  separate, explicit wrapper scope rather than entering default coding-session discovery.
  The vendored primitive owns canonical-ID exclusion and its opt-in candidate aperture, which
  groups the complete ranked match set by stable session ID before applying limits or output
  budgets; literal/IDF ranking remains unchanged.
- `.claude/skills` contains development-agent instructions and is never loaded by the product agent.

## State and events

SQLite (`~/.owner-operator/state.db`) is the only durable truth. `State` is its only production
writer. The active `/session-state` response is a projection over `threads` and the latest dense
`thread_details` version; there is no stored snapshot or embedded client store.
`state.db` starts clean; the retired `threads.db` is not an upgrade source.

After a transaction commits, `State` publishes a rich typed event on a fail-isolated in-memory bus.
The bus wakes consumers; clients refetch truth rather than consuming event payloads. The Gateway maps domain events to three typed SSE
invalidations—state, schedule, or schedule-run changed—and clients refetch SQLite-backed truth.

Enrichment is eligible when the current state is `needs-you` and `last_message_at` differs from
`enriched_through_message_at`. This catches first discovery, a new assistant message without a state
transition, and daemon restart. The monitor never awaits the model in its scan hot path.
The synchronous transcript parser and git inspection run in a child process, so reconciliation
cannot block Gateway health, SSE, or widget requests. Periodic scan failures are logged and retried
at the next normal reconciliation instead of becoming unhandled rejections; enrichment failures use
the same logged background seam and leave the durable watermark eligible for a later retry.

## Scheduler

The daemon composes one scheduler. Schedule definitions, next-run timestamps, execution
history, and needs-you watermarks persist through `State`; the scheduler owns calendar
evaluation, wakeups, and execution. The typed vocabulary is:

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
Commands execute exact `argv` without a shell unless a caller deliberately supplies
`["/bin/sh", "-lc", command]`.

Scheduler policy:

- Global concurrency starts at one; the same job never overlaps.
- Overdue one-shots run once. Recurring jobs skip backlog and record timing/missed counts in run context.
- Timer occurrences advance and create their running row in one transaction before external work starts.
- Manual triggers return their durable `running` row immediately; clients inspect run completion through `schedule_runs`.
- A daemon crash marks running rows `interrupted`; no automatic job retry occurs.
- Commands and prompt runs have bounded timeouts and bounded stdout/stderr tails.
- Shutdown aborts active runs, terminates command process groups, and drains the queue before State closes.
- Disabling/deleting prevents future triggers but does not cancel an active run.
- A monotonic schedule revision prevents an active run from overwriting a concurrent edit.
- Needs-you changes batch once per reconciliation; run creation and per-thread watermarks commit atomically.

Users inspect `schedules` and `schedule_runs` through the existing read-only `query_database` tool.
The table intent and columns live once in `src/state/schema-docs.ts`.

## Daemon and clients

The daemon binds only `127.0.0.1`. Its mode-`0600` discovery file carries a fresh bearer token;
every HTTP/SSE request authenticates with it. `/health` reports PID, start time, fingerprint, and
staleness; `/ready` reports module initialization. Clients require readiness. Production clients
never open SQLite and there is no `OO_DAEMON=0` mode.

The runtime fingerprint hashes `src`, `packages/core`, package metadata, and Pi settings, including
uncommitted changes. A mismatch marks the daemon stale and exits it gracefully; launchd or the
terminal ensure path starts the current runtime. This adapts OpenClaw's installed service-version
stamp ([source](https://github.com/openclaw/openclaw/blob/372b527da4a1cee5b819e7852f6e26ef11160e85/src/daemon/service-env.ts#L430-L446))
to a development checkout where source content—not package version—is authoritative.

When the daemon LaunchAgent is installed, launchd is the only process supervisor and terminal
clients request replacement through `launchctl kickstart`. Without the LaunchAgent, terminal clients
may start one detached daemon directly. Before replacement, the client authenticates the stale or
unready daemon identity and waits for it to release the Gateway; it never signals an unverified PID.
LaunchAgent ownership is verified against `launchctl print`; if an authenticated detached daemon
predates installation, the client stops it and waits for the port before handing ownership to launchd.
An ambiguous launchctl result fails closed and never authorizes direct signaling.
Long-lived Node clients invalidate cached discovery after authentication or connection failure, and
their SSE subscriptions reread `daemon.json` before reconnecting.

The widget installer installs both LaunchAgents. The widget itself remains a pure Gateway client
and never spawns a process. Owner Operator's own scheduled-session transcripts are searchable
but excluded from coding-session monitoring, preventing automation loops.
