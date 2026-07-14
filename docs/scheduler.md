---
title: "Scheduler"
summary: "Durable prompt/command schedules: triggers, isolated runs, policy, run history"
read_when:
  - Creating or debugging a schedule or its runs
  - Changing scheduler triggers, payloads, or policy
---

# Scheduler

The daemon composes one scheduler. Schedule definitions, next-run timestamps,
execution history, and needs-you watermarks persist through `State`; the
scheduler owns calendar evaluation, wakeups, and execution. The typed vocabulary
is:

- Trigger: `at`, `every`, `cron` with an explicit IANA time zone, or `needs-you`.
- Payload: `prompt` or direct `argv` command.
- Prompt tools: concrete `AgentToolId[]`; presets are resolved upstream.
- Run context: absolute `cwd`, timeout, immutable payload snapshot, and trigger context.

Cron evaluation uses [`croner`](https://github.com/Hexagon/croner) (pinned in
`package.json`), following OpenClaw's proven
[Croner adapter](https://github.com/openclaw/openclaw/blob/372b527da4a1cee5b819e7852f6e26ef11160e85/src/cron/schedule.ts#L1-L55).
Our small public scheduler seam mirrors OpenClaw's explicit
[cron service contract](https://github.com/openclaw/openclaw/blob/372b527da4a1cee5b819e7852f6e26ef11160e85/src/cron/service-contract.ts#L27-L45)
without copying its product-specific delivery system.

The agent creates durable schedules through the typed `schedule_prompt` tool.
Prompt runs create a fresh Pi `SessionManager` and transcript under
`~/.owner-operator/sessions`; `oo-provenance` records job/run identity. This
follows OpenClaw's isolated-job rule:
[a new transcript/session id per run](https://github.com/openclaw/openclaw/blob/372b527da4a1cee5b819e7852f6e26ef11160e85/docs/automation/cron-jobs.md#L203-L220).
Commands execute exact `argv` without a shell unless a caller deliberately
supplies `["/bin/sh", "-lc", command]`. Scheduled-run transcripts are searchable but excluded
from coding-session monitoring, preventing automation loops.

## Policy

- Prompt schedules are headless and inherit the global permission baseline
  ([agent.md — Permissions](agent.md#permissions)); calls that would prompt are denied because
  no human authority is present. `toolsAllow` independently narrows tool availability.
- The scheduled task cwd activates repository `.pi` permission rules
  ([agent.md — Permissions](agent.md#permissions)).
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

Failures and output are inspectable through the read-only `query_database` tool
over `schedules` and `schedule_runs`. The table intent and columns live once in
[`src/state/schema-docs.ts`](../src/state/schema-docs.ts).
