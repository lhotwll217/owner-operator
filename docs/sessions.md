---
title: "Sessions"
summary: "Session identity model: harness, transcript format, store, host; catalogs and onboarding review"
read_when:
  - Adding or changing a supported harness, transcript format, or session host
  - Tracing why a session is attributed to a given app or CLI
---

# Sessions

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
