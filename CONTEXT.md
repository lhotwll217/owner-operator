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

**Harness details**:
An ephemeral, read-only observation of what a **Harness** currently offers.
Never stored: a details snapshot is only true as of the moment it was observed.
_Avoid_: harness config, harness capabilities (that is a **Capability record**)

**Advertised model**:
A model a **Harness** itself reports in its catalog, with the reasoning levels
it supports. Distinct from a model Owner Operator assumes or a caller pins.

**Allowance window**:
One subscription-allowance period a **Harness** reports, with the share of it
already spent and when it resets. Never a token count or a price.

**Baseline candidate**:
The model and reasoning level a **Harness** selects for itself when Owner
Operator pins nothing. A proposal, not a setting — it is reported, never saved.

**Delegation depth**:
How many **Delegated runs** separate a run from the Operator.

**Retry**:
A new **Delegated run** that reruns the same task after a run failed, was
interrupted, or was lost.

**Resume**:
A new **Delegated run** that sends a required new task after a run completed,
using the same **Child agent** conversation.

**Schedule run**:
One execution of a durable schedule, triggered by time or events rather than a
parent agent.

## Flagged ambiguities

- "background agent" — resolved: a **Delegated run** in background mode, never
  a scheduler job.

Lifecycle, retry and resume guarantees, and capability behavior live in
[docs/delegated-runs.md](docs/delegated-runs.md).
