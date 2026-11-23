---
title: "Sessions"
summary: "Session identity model: harness, transcript format, store, host; catalogs and onboarding review"
read_when:
  - Adding or changing a supported harness, transcript format, or session host
  - Tracing why a session is attributed to a given app or CLI
  - Determining why a transcript does or does not become a session-state or widget row
---

# Sessions

Four identities stay separate:

| Identity | Example | Owns |
|---|---|---|
| Agent harness | Claude Code | Agent runtime the owner used |
| Transcript format | `claude` | Record shape the scanner parses |
| Transcript store | `~/.claude/projects` | Directory containing that format |
| Session host | Claude App, Claude CLI, Superset App | Owner-facing app or CLI used to open the session |

Session observation and execution ownership are orthogonal. The scanner decides whether a
transcript becomes an ordinary `/session-state` row. Separately, the `agent_runs` ledger records
whether Owner Operator issued and owns a child execution. An observed session need not be
OO-delegated, and an OO-delegated run need not have an admitted transcript row. The canonical
tracked-versus-untracked matrix, including native sub-agents, lives in
[Sub-agents and delegated runs](delegated-runs.md#tracking-boundary).

[`AGENT_HARNESS_DESCRIPTORS`](../packages/core/src/session-sources.mjs) is the canonical
supported-harness catalog. Each harness names one implemented transcript format and its store
candidates. [`SESSION_HOST_DESCRIPTORS`](../packages/core/src/session-hosts.mjs) separately
names apps, CLIs, and internal SDK transports. Rooted hosts win over transcript metadata, so a
Codex or Claude session inside a Superset worktree belongs to Superset. Superset roots are read
from its legacy and current settings databases because the worktree home is configurable.

Owner Operator's own Pi-format transcripts are a product-owned store, composed separately from
the owner-authorized external harness stores. Owner-origin chat and interactive sessions enter the
ordinary monitor and session-state pipeline as `Owner Operator` roots. Schedule, scheduler-origin,
and agent-origin sessions remain automated. Their task repository and directory come from the
latest valid `oo-provenance` entry because the Pi header cwd is stable lookup identity, not task
context. This product store never authorizes or reports access to standalone Pi history, and its
scan cannot displace external sessions.

The monitor respects the configured active window and updates all candidates in that window
without the old per-source count cap. A full scan also re-observes, by transcript path, every
visible row the window passed, so an old needs-you or snoozed row keeps a current deep link and
workspace diff. A transcript Codex has compressed to `.jsonl.zst` cannot be re-observed. Widget visibility retains the existing window rules,
including outstanding owner attention and active delegated children. Reconciliation selects
only visible working, idle, or needs-you rows. It does not queue quiet history outside the widget window.
Codex guardian source metadata identifies approval machinery rather than independent owner work.
CLI sessions enter monitoring from their first real message, including one-off sessions.
Explicit automated transports and product-origin exclusions still apply.

The authenticated `POST /poll` accepts an optional `reconcile` array of up to 100
`{id, lastMessageAt}` pairs. It resets enrichment eligibility only for matching visible unresolved working, idle, or
needs-you rows, including parents with active delegated children, then runs the normal monitor.
The response's `queuedIds` identifies accepted rows. A timestamp mismatch or Done choice is skipped.
This route rechecks already summarized visible rows after a reconciliation change without another worker.

## OpenCode

OpenCode's configured store is its legacy `storage/` tree of one JSON file per record. Current
OpenCode keeps sessions in `opencode.db` in the same data directory
([database path](https://github.com/anomalyco/opencode/blob/d284e7ce17d0a98c80d0bebd5cc6dce2dbdd5f74/packages/cli/src/database-path.ts#L4-L13)),
so authorizing the store authorizes that database too, and either may exist alone. The
[reader](../packages/core/src/opencode-sessions.mjs) opens it read-only and reads v1 sessions
(`session`, `message`, `part`) and v2 sessions (`session_v2`, `session_message`); a migrated
session's v2 rows win over its v1 copy. Each database session is one scan candidate whose
transcript path is `<db>#<session id>`. The monitor watches the database and its WAL, not the
`-shm` index that reads also change.

`oo search` leaves OpenCode to agentsview, which indexes `opencode.db` itself: a hit keeps
agentsview's message ordinal and context. agentsview indexes every OpenCode database it finds, so a
hit counts only when a configured store's `opencode.db` holds the session, whose `directory` decides
the blacklist. A hit whose message text lacks the match, such as a tool hit, is dropped. A hit opens with `agentsview session messages opencode:<id> --around <idx>`. Without a
running agentsview, OpenCode sessions are not searched (`oo search --help`, section Backends).

## Onboarding review

Onboarding presents both catalogs once. Harness formats start selected; the owner marks formats to
ignore. Host detection supplies attribution only and does not grant transcript access. The marker
records the reviewed stable IDs and an access contract hash. Harness identity, transcript format,
standard-store scope, or host attribution changes reopen only this review; labels and detection hints do not. The scanner asserts
that every catalog format has an implementation and the integration suite exercises every parser.
The same review can run the bounded deep search or accept an explicit absolute transcript-store
path; neither adds a mandatory onboarding screen.
