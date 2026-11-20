---
title: "Scheduler"
summary: "Durable prompt/command schedules: triggers, isolated runs, policy, run history"
read_when:
  - Creating or debugging a schedule or its runs
  - Changing scheduler triggers, payloads, or policy
---

# Scheduler

The daemon composes one scheduler. Schedule definitions, next-run timestamps,
execution history, needs-you watermarks, and run-finished claims persist through `State`; the
scheduler owns calendar evaluation, wakeups, and execution. The typed vocabulary
is:

- Trigger: `at`, `every`, `cron` with an explicit IANA time zone, `needs-you`, or `run-finished`
  with an `origin`.
- Payload: `prompt` or direct `argv` command.
- Prompt tools: concrete `AgentToolId[]`; presets are resolved upstream.
- Run context: absolute `cwd`, timeout, immutable payload snapshot, and trigger context.

Cron evaluation uses [`croner`](https://github.com/Hexagon/croner), following OpenClaw's proven
[Croner adapter](https://github.com/openclaw/openclaw/blob/372b527da4a1cee5b819e7852f6e26ef11160e85/src/cron/schedule.ts#L1-L55).
Our small public scheduler seam mirrors OpenClaw's explicit
[cron service contract](https://github.com/openclaw/openclaw/blob/372b527da4a1cee5b819e7852f6e26ef11160e85/src/cron/service-contract.ts#L27-L45)
without copying its product-specific delivery system.

The agent creates, disables, and deletes durable schedules through `oo schedules` from bash
([cli.md](cli.md)); `create` takes a prompt schedule as flags or any schedule as a
`POST /schedules` body.
Prompt runs create a fresh Pi `SessionManager` and transcript under
`~/.owner-operator/sessions`; `oo-provenance` records job/run identity. This
follows OpenClaw's isolated-job rule:
[a new transcript/session id per run](https://github.com/openclaw/openclaw/blob/372b527da4a1cee5b819e7852f6e26ef11160e85/docs/automation/cron-jobs.md#L203-L220).
Commands execute exact `argv` without a shell unless a caller deliberately
supplies `["/bin/sh", "-lc", command]`. A command run with a trigger context reads it as
JSON on stdin, then EOF; a run without one (a manual trigger) gets an empty stdin. Context never
goes in argv or the environment. Prompt runs get the same context appended to the prompt. Scheduled-run transcripts are searchable but excluded
from coding-session monitoring, preventing automation loops.

## Waking an outside caller

A run started with `oo runs delegate --origin <name>` has no local parent to wake
([delegated-runs.md](delegated-runs.md)). Both sides trim the origin before matching. A
`run-finished` schedule for that origin fires at least once for
each of its runs that reaches a terminal status: `completed`, `failed`, `cancelled`,
`interrupted`, or `lost`. The same `runId` can arrive twice, so dedupe by it. The context is `{ "runId", "status", "origin", "finishedAt" }`; the
command reads the rest with `oo runs get <runId>`. Create one with
`oo schedules create --from <file>`:

```json
{
  "name": "wake my-caller",
  "enabled": true,
  "trigger": { "kind": "run-finished", "origin": "my-caller" },
  "payload": { "kind": "command", "argv": ["/bin/sh", "/absolute/path/to/your-wake-script.sh"] },
  "cwd": "/absolute/path/to/a/working/directory",
  "timeoutSeconds": 60
}
```

The script owns delivery: what it calls and with which credentials. Have it read secrets from a
file or keychain, never from argv, because `payload_json` is stored and queryable.

## Policy

- Prompt schedules are headless and inherit the global permission baseline
  ([agent.md — Permissions](agent.md#permissions)); calls that would prompt are denied because
  no human authority is present. `toolsAllow` independently narrows tool availability.
- The scheduled task cwd activates repository `.pi` permission rules
  ([agent.md — Permissions](agent.md#permissions)).
- Schedules run concurrently, so a slow or hung command delays no other schedule. The same
  schedule never overlaps itself; a trigger that comes due while it runs waits for it to end.
  Commands run detached and survive a daemon crash, so startup SIGKILLs the process group recorded
  on each `running` row before marking it `interrupted`.
- Overdue one-shots run once. Recurring jobs skip backlog and record timing/missed counts in run context.
- Timer occurrences advance and create their running row in one transaction before external work starts.
- Manual triggers return their durable `running` row immediately; clients inspect run completion through `schedule_runs`.
- A daemon crash marks running rows `interrupted`. Only a run-finished wake is retried (below).
- Commands and prompt runs have bounded timeouts and bounded stdout/stderr tails.
- Shutdown aborts active runs, terminates command process groups, and waits for every run to
  record its outcome before State closes.
- Disabling/deleting prevents future triggers but does not cancel an active run.
- A monotonic schedule revision prevents an active run from overwriting a concurrent edit.
- Needs-you changes batch once per reconciliation; run creation and per-thread watermarks commit
  atomically. Roots with pending or running delegated children are excluded, and an agent-run
  transition reconciles the inputs so the transcript-derived handoff returns after termination.
- A run-finished claim commits the schedule run with a `schedule_run_finished_claims` row, one per
  schedule and agent run, so events and ticks claim each run once. A terminal agent-run event
  starts a claim pass, and so does every tick, which catches runs that ended before startup,
  during downtime, or in the lost sweep.
- An idle schedule claims its oldest pending wake and starts the command in the same step. A busy
  schedule is offered its next wake when its current run ends, so each caller works through its
  own backlog and never holds back another caller's wake.
- Wakes are delivered at least once, so the same wake can repeat and callers dedupe by `runId`. A
  wake whose schedule run ends `interrupted`, because shutdown aborted its command or the daemon
  died before recording its outcome, is claimed again on the first pass after restart, with the
  same context. That includes a crash after the command exited but before its outcome was saved.
  A wake whose recorded outcome is `completed` or `failed`, including a timeout, is not retried;
  retrying a failed delivery, such as an HTTP error, is the command's job.
- Saving a run-finished schedule claims every run of its origin that is already terminal, in the
  same transaction, so creating, editing, or re-enabling a schedule never replays history.

Failures and output are inspectable through read-only `oo db query`
over `schedules` and `schedule_runs`. The table intent and columns live once in
[`src/state/schema-docs.ts`](../src/state/schema-docs.ts).
