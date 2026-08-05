# Owner Operator — Domain Glossary

Language pinned during design sessions. Glossary only — behavior and
implementation live in [docs/](docs/).

## Language

**Sub-agent**:
Broad relationship term for an agent launched to help another agent. An
OO-owned sub-agent is represented by a **Delegated run**; a harness-native
sub-agent is not.

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

**Pulse**:
A built-in recurring review of ongoing work that notifies the owner through the
widget (expand + sound) with a brief, actionable-only message — stalled work to
move, cleanup to do. A quiet fleet produces no Pulse: the interval (owner-set at
onboarding, default 25 minutes) caps frequency but guarantees nothing fires.
A Pulse speaks only about **Threads** the owner can act on in the widget;
work that is not interactable is not Pulse-eligible.
_Avoid_: check-in, briefing, standup, status update

**Thread**:
A unit of ongoing work as the owner sees and interacts with it in the widget,
backed by session state. Work is always a thread, never a "row" — a row is
rendering, not the work.
_Avoid_: row, session-state row

## Flagged ambiguities

- "background agent" — resolved: a **Delegated run** in background mode, never
  a scheduler job.

Lifecycle, lineage, capability guarantees, and resume behavior live in
[docs/delegated-runs.md](docs/delegated-runs.md).
