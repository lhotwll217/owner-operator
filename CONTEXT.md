# Owner Operator — Domain Glossary

Language pinned during design sessions. Glossary only — behavior and
implementation live in [docs/](docs/).

## Language

**Delegated run**:
One daemon-owned execution of a child agent, represented by a durable ledger row.
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
harness.

**Delegation depth**:
How many **Delegated runs** separate a run from the Operator.

**Schedule run**:
One execution of a durable schedule, triggered by time or events rather than a
parent agent.

## Flagged ambiguities

- "background agent" — resolved: a **Delegated run** in background mode, never
  a scheduler job.

Lifecycle, lineage, capability guarantees, and resume behavior live in
[docs/delegated-runs.md](docs/delegated-runs.md).
