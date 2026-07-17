# Owner Operator — Domain Glossary

Language pinned during design sessions. Glossary only — behavior and
implementation live in [docs/](docs/).

## Language

**Delegated run**:
One execution of a child agent launched through Owner Operator's ledger, owned
by the daemon. Durable: identified by a run row with lifecycle
`pending → running → {completed | failed | cancelled | interrupted | lost}`.
_Avoid_: subagent run, background job (that is a **Schedule run**)

**Child agent**:
The agent session a **Delegated run** executes — a first-class session of its
own harness (Claude Code, Codex, …) with its own session identity, observable
as a thread once its transcript is seen.
_Avoid_: subprocess, worker

**Harness**:
The coding-agent runtime a session belongs to (pi, Claude Code, Codex, …).
Each harness a delegated run may target carries a **Capability record**.

**Capability record**:
Per-harness declaration of what Owner Operator can do with a child of that
harness: activity source, steer, asks-to-parent, resume. The floor is never
zero — every harness gets a durable run row, activity, inspect/cancel/result.

**Delegation depth**:
How many **Delegated runs** deep a run sits, stamped at spawn. The Operator's
own session is depth 0. Cap: 2 — a child may delegate (e.g. a review agent),
a grandchild may not. Harness-native subagents inside a child do not count;
depth only counts runs launched through the ledger.

**Schedule run**:
One execution of a durable schedule (scheduler subsystem). Shares lifecycle
vocabulary with **Delegated run** but is triggered by time/events, not by a
parent agent.

## Relationships

- A thread (session identity) may be the parent of many **Delegated runs**
- A **Delegated run** executes exactly one **Child agent** session
- Resume creates a new **Delegated run** under the same **Child agent** identity
- A **Harness** has one **Capability record**

## Flagged ambiguities

- "background agent" — resolved: a **Delegated run** in background mode;
  never a scheduler job. "Frozen/blocked parent" is not a state in this model:
  results are carried by the ledger, never by the parent tool call.
