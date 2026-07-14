---
title: "Architecture"
summary: "Module ownership, harness boundary, session inventory, agent capabilities, state/events"
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

## Harness boundary

Code and agent state have separate roots:

| Scope | Path | Responsibility |
|---|---|---|
| Install root | checkout/package | executable code and bundled prompt, tools, and skills |
| Harness home | `OO_HOME` or `~/.owner-operator` | config, copied credentials/model settings, SQLite, transcripts, logs, daemon files |
| Agent workspace | `OO_HOME/workspace` | persistent `AGENTS.md`, memory, artifacts, and workspace skills |
| Task cwd | caller or scheduled-run cwd | file and command target for that run |

Every entry point creates missing workspace files without overwriting owner edits. Embedded Pi uses
`OO_HOME/pi` for its auth, settings, custom models, and agent state; it does not change standalone
Pi. The resource loader disables ambient context, extensions, skills, prompts, and themes, then
adds only the product prompt, bundled skills, workspace `AGENTS.md`, workspace skills, and personal
skills explicitly selected during onboarding, plus the pinned permission-system extension.

The core config API is authoritative; onboarding is its first-run TTY client. Before the versioned
consent marker is complete,
the daemon does not scan or enrich transcripts, headless model calls return setup-required, and the
widget displays setup-required. `oo doctor` and `oo status` report the effective boundary without
printing credential values.

## Session inventory

Four identities stay separate:

| Identity | Example | Owns |
|---|---|---|
| Agent harness | Claude Code | Agent runtime the owner used |
| Transcript format | `claude` | Record shape the scanner parses |
| Transcript store | `~/.claude/projects` | Directory containing that format |
| Session host | Claude App, Claude CLI, Superset App | Owner-facing app or CLI used to open the session |

`AGENT_HARNESS_DESCRIPTORS` is the canonical supported-harness catalog. Each harness names one
implemented transcript format and its store candidates. `SESSION_HOST_DESCRIPTORS` separately
names apps, CLIs, and internal SDK transports. Rooted hosts win over transcript metadata, so a
Codex or Claude session inside a Superset worktree belongs to Superset. Superset roots are read
from its legacy and current settings databases because the worktree home is configurable.

Onboarding presents both catalogs once. Harness formats start selected; the owner marks formats to
ignore. Host detection supplies attribution only and does not grant transcript access. The marker
records the reviewed stable IDs and an access contract hash. Harness identity, transcript format,
standard-store scope, or host attribution changes reopen only this review; labels and detection hints do not. The scanner asserts
that every catalog format has an implementation and the integration suite exercises every parser.
The same review can run the bounded deep search or accept an explicit absolute transcript-store
path; neither adds a mandatory onboarding screen.

## Agent capabilities

- **Tools** are executable, typed Pi capabilities defined under `src/agent/tools`. Same-name direct
  file-tool guards at the Agent boundary enforce explicit path, repository-name, and symlinked-path
  blacklists. The Bash wrapper supplies the task cwd and Owner Operator provenance environment.
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

The built-in posture exposes `read`, `grep`, `find`, `ls`, `bash`, `edit`, and `write`. The owner
selects a permission mode during onboarding and changes it later with `/permissions`.
`@gotgenes/pi-permission-system` owns rule
evaluation, prompts, and session grants; Owner Operator does not classify executables or shell
subcommands. The concrete core adapter reconciles only the selected defaults and marker-owned
blacklist rules into Pi's global config; it preserves advanced Pi settings and specific rules.
Blacklist paths feed Pi's cross-tool path policy as lexical and filesystem-resolved identities.
Direct `grep`, `find`, and `ls` also reject a parent whose traversal could reach a blacklisted
descendant. Bash process-internal access, non-literal paths, POSIX case variants, and repository-name
entries require separate [sandbox work](https://github.com/lhotwll217/owner-operator/issues/61).
Specific global and trusted task-repository `.pi` rules use Pi's standard precedence and may
deliberately override these defaults and generated Pi path rules; direct file-tool privacy guards
remain authoritative. Pi also floors opaque or execution-wrapper shell commands to `ask`, including
in `allow` mode.
Adoption is recorded with pinned sources in [docs/inspiration.md](inspiration.md).

## State and events

SQLite (`~/.owner-operator/state.db`) is the only durable truth. `State` is its only production
writer. The active `/session-state` response is a projection over `threads` and the latest dense
`thread_details` version; there is no stored snapshot or embedded client store.
On first creation, `state.db` does not import the retired `threads.db`.

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

## Scheduler and daemon lifecycle

Each has its own page: the scheduler's typed vocabulary, isolated runs, and
policy in [scheduler.md](scheduler.md); daemon auth, readiness, staleness, and
LaunchAgent supervision in [daemon.md](daemon.md).
