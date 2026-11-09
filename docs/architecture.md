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
        ┌─────────────┬───────┴───────┬─────────────┐
 session monitor   worktrees        state       scheduler
 scan + enrich   Git topology    sole writer   Croner + runs
        │              │             │             │
 coding + OO         git CLI       SQLite    fresh Pi session / argv process
 transcripts
```

## Module ownership

| Module | Owns | Does not own |
|---|---|---|
| `packages/core` | Shared enums, types, pure state rules, wire contract, dependency-light filesystem config readers; browser-safe presentation/protocol contracts use dedicated subpath exports | SQLite, network, timers, processes, model calls |
| `src/state` | SQLite schema, transactions, projections, post-commit events, read-only query docs | Polling, HTTP, model calls |
| `src/session-monitor` | Transcript scan/watch and its private async enrichment worker | HTTP, scheduling |
| `src/session-search` | Privacy-aware transcript search, its pinned search primitive, and the optional agentsview discovery backend, shared by the monitor and `POST /session-search` (`oo search`) | State writes, model calls |
| `src/scheduler` | Typed jobs, Croner calendar math, execution, run history, needs-you dedupe | HTTP, SQLite access outside `State` |
| `src/agent-runs` | Delegated-run executor, ACP launcher over `acpx`, and client-side parent-fleet reconciliation adapters | SQLite access outside `State`, HTTP |
| `src/worktrees` | Argv-safe Git worktree inspection/creation and create/list/select orchestration | SQLite writes, runtime cwd binding, cleanup |
| `src/gateway` | Loopback HTTP/SSE translation and client SDK | SQLite, child processes, polling, model calls |
| `src/daemon` | Composition, process lifecycle, readiness, discovery, source fingerprint | Domain decisions |
| `src/agent` | Owned Pi runtime, onboarding, diagnostics, typed tools, Agent Skills, scheduled prompt runner, typed enrichment completion | Timers or direct SQLite |

Dependencies point toward the owning seam:

```text
core ← state ← { session-monitor, scheduler, agent-runs, worktrees, gateway } ← daemon
core ← gateway client ← { agent, CLI, widget }
```

The Gateway server receives module interfaces from the daemon. It does not import the monitor or
scheduler implementations. `src/gateway/gateway.boundaries.test.ts` enforces that transport owns no
process/model runtime and that application code never loads from development-skill directories.

## State and events

SQLite (`~/.owner-operator/state.db`) is the only durable truth. `State` is its only production
writer. The active `/session-state` response is a projection over `threads`, the latest dense
`thread_details` version, and active delegated-child relationships; there is no stored snapshot or
embedded client store. A root with a pending or running child projects as `working` without
rewriting its transcript-derived state. An owner snooze is the same kind of read-time overlay: two
`threads` columns evaluated against the injected clock, never cleared at expiry. While it holds,
the row projects in the snoozed section with its state unchanged; done outranks it, and it
outranks an active child. The projection's rows leave `State` already arranged into sections and
display order. The monitor stores each thread's deep link on `threads.link`, replaced on every
observation: Codex's from the scan, Claude's from the desktop app's session records
(`src/session-monitor/claude-desktop-sessions.ts`), which fail closed. Adding the column backfills
Codex App and CLI threads observed before it existed. A row's `+N −N` is its workspace's diff from the
branch's configured base, else from the merge-base with the remote's default branch. Once a root has a worktree selection, the projection uses
that registered worktree's repository and path for `repo` and `project`; without a selection it
retains transcript provenance. Projection does not inspect path availability, so an unavailable
selection stays visible for diagnosis.
`worktrees` stores only Owner Operator creation provenance and Git common-directory identity;
`thread_worktrees` stores one current selection per root without requiring prior transcript
ingestion. Git remains authoritative for branch, HEAD, dirty state, and live topology.

After a transaction commits, `State` publishes a rich typed event on a fail-isolated in-memory bus.
The bus wakes consumers; clients refetch truth rather than consuming event payloads. The Gateway maps
domain events to four typed SSE invalidations—state, schedule, schedule-run, or agent-run changed—and
clients refetch SQLite-backed truth.

Enrichment makes two independent calls per thread, each reading through application-owned
scan/search modules. Every visible `needs-you`, `idle`, or `working` row is eligible, including
parents with active delegated children.

- **Need You** ([needs-you.ts](../src/agent/needs-you.ts)) is asked only of a stopped session: a
  running turn or an active delegated child is already `working`, deterministically. It sends the
  owner's last two messages and the agent's last two, whole and without tool calls, with the
  thread's three latest distinct status summaries, to one Jev question: did the agent stop with
  the current task unfinished? Work handed to the owner for review counts as unfinished; work the
  owner stopped does not. A score at or above the threshold is `needs-you`,
  otherwise `idle`. A scan alone sees a turn end, not whether the task is done, so `needs-you`
  comes only from this call.
- **Title and status summary** ([enrichment.ts](../src/agent/enrichment.ts)) read a bounded sample:
  Claude, Codex, and Pi samples include bounded tool evidence through the privacy-aware
  session-search helper; other formats retain the scan sample. The model records them through one
  strict-schema tool call: the prompt carries the alignment examples and the 120-character
  target, the schema carries a backstop above it, and `null` keeps the current title or status
  summary unchanged. What the model returns is shown; there is no length gate. The model also
  reads the thread's last three recorded status-summary revisions with their positions, so a new
  revision continues that account. This call never sets state; when it fails, the Need You answer
  still lands and the row stays eligible until a title and status summary do.

Completed work stays visible until an explicit Done action.
Enrichment runs several threads at once, bounded by `enrichConcurrency` (default 10). A poll
that lands while a pass is running gets its own pass afterwards, so a turn ending or a child
starting is reassessed within one model call rather than at the next tick.

The monitor scans every store once at start. From then on the transcript watcher names the file
that changed and the scan parses only that transcript and the files sharing its session id; the
interval tick only reassesses working sessions on their cadence. Without an armed watcher the
interval falls back to a full scan.

The message watermark, sampled child evidence, enrichment-contract version, and whether
enrichment landed during working status determine freshness.
A newer message or a change in working status queues another assessment. Failed calls leave
the row eligible for retry. Owner Done and newer messages reject stale results; regressed
transcript timestamps cannot overwrite a newer watermark. Unchanged settled assessments survive
polling and restart. A contract change makes an older assessment eligible for one refresh. Titles
preserve owner renames, and a generated title holds still until the
work changes categorically. The projection keeps the last generated status summary while a newer
one is pending and reports that with `statusSummaryPending`; a row with no status summary yet shows its
title alone. A revision is written when the meaning changes and records the session position it
was written from, so a reader can return to that point; a reassessment that lands on the same
understanding advances the clock alone. Working sessions are reassessed about every four minutes.
The monitor never awaits the model in its scan hot path.
Observed child transcripts and run statuses accompany the parent sample within a bounded context.
Child message or run-status changes refresh the parent status summary and reject an in-flight older result.
The synchronous transcript parser and git inspection run in a child process, so reconciliation
cannot block Gateway health, SSE, or widget requests. Periodic scan failures are logged and retried
at the next normal reconciliation instead of becoming unhandled rejections; enrichment failures use
the same logged background seam and leave the durable watermark eligible for a later retry.

## Surface pages

Behavior lives with its surface; `npm run docs:list` prints every page with its
routing frontmatter.
