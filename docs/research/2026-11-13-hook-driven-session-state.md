# Hook-driven session state — design for review

Investigation only. No implementation. Orca was read at
[`57c9991c9821e68b4df1896d172b756c282012fb`](https://github.com/stablyai/orca/commit/57c9991c9821e68b4df1896d172b756c282012fb)
(2026-11-13). Owner Operator citations are this checkout (`main` at the time of the branch).

Sessions stay the source of truth for what the work *is*. Hooks are how the harness tells us
what the session is *doing*. Transcripts stay the source of titles, status summaries, and
search. Owner Done stays an owner action. Orca's `done` means "the turn ended"; Owner
Operator's `done` means "the owner dismissed the row". Those must not be merged.

## How state is derived today

```text
transcript file
  → scan-active-transcripts.mjs  (working flag, lastRole, lastMessageAt; fold subagents; drop automated)
  → resolve.mjs deriveState / holdsDone
  → SessionMonitor.poll → State.recordObservation → thread_details written_by=poll
  → enrichment (only if the projected state is not working)
       Jev classifyStoppedSession → needs-you | idle, plus awaiting
       enrichThread → title + status summary (never sets state)
  → SQLite projection (active delegated child, awaiting overlay, snooze, Done)
  → arrangeSessionState
  → GET /session-state
  → widget, `oo session-state list`
```

The widget and the CLI do not derive state. Both render
[`GET /session-state`](../../src/gateway/server.ts).

The scan's `working` flag is a guess from the last record
([`scan-active-transcripts.mjs`](../../src/session-monitor/scan-active-transcripts.mjs)):

| Format | `working` when |
|---|---|
| Claude (default) | last assistant message has `stop_reason: tool_use` |
| Codex | last lifecycle event is `task_started` |
| Cursor | last block is `tool_use` |
| Pi | last assistant `stop` is `toolUse` |
| OpenCode | last assistant message has no `completed` time |

[`deriveState`](../../packages/core/src/resolve.mjs) then: `working` flag wins; else 30 minutes
quiet → `idle`; else last role `user` → `working`, last role `assistant` → `idle`. It never
emits `needs-you`. A comment there says a scan cannot tell a finished task from a yielded turn.

[`holdsDone`](../../packages/core/src/resolve.mjs) keeps owner Done only while
`candidate.lastMessageAt <= persisted.lastMessageAt`. Any newer transcript message wakes the
row. [`INJECTED_OWNER_TEXT`](../../packages/core/src/session-text.mjs) (task notifications,
interrupts, local commands) is used when sampling turns. Done does not consult it.

[`recordObservation`](../../src/state/state.ts) keeps an already-enriched `needs-you` or `idle`
when the message watermark has not moved and the row is not working. A later poll cannot
correct it.

Need You is one Jev call, [`classifyStoppedSession`](../../src/agent/needs-you.ts), asked only
when the projected state is not working ([`runtime.ts`](../../src/daemon/runtime.ts)). Score
≥ 0.5 → `needs-you`, else `idle`. A second score, `awaiting` ≥ 0.7, means "the agent says its
own sub-agent or background command is still running". That sets
`threads.awaiting_through_message_at`, and the projection paints the row `working` until a
newer message. There is no timer and no process check.

While the row is working, or it has a pending/running delegated child, the model answer is
stored as a summary only. The state column is left alone
([`appendModelDetailsIfFresh`](../../src/state/database.ts)).

The projection then overlays, in order: owner Done, the awaiting flag, an active delegated
child (`agent_runs.status` pending or running → parent `working`). Needs-you rows skip the
active-window cutoff, so they stay on the list indefinitely.

[`arrangeSessionState`](../../packages/core/src/session-state.ts) puts a child in its parent's
section, at any depth. The child's own state does not pick the section. The widget renders
that order and does not recompute it.

Harness-native sub-agents are folded into one row per session id. The non-subagent transcript
wins, so a subagent's `working` flag is discarded. Claude SDK (`entrypoint` `sdk-ts` /
`sdk-python` / `sdk-cli`) and Codex SDK (`originator` `codex_sdk_ts` / `codex-sdk`) are
`automatedTransport` hosts ([`session-hosts.mjs`](../../packages/core/src/session-hosts.mjs)).
The monitor drops them. `oo search` and `--thread` do not, which is why a child can be
searchable and absent from `threads`.

ACP delegated runs are launched through those SDKs
([`docs/delegated-runs.md`](../delegated-runs.md)). A child becomes a widget row only after
the scanner admits its transcript and `agent_runs.child_session_id` matches. Parent summaries
learn about children through a SQL join of `agent_runs` to `threads`. No thread row means
`enriched_children` is `[]`.

## Root cause of each bug

| Issue | Cause |
|---|---|
| [#195](https://github.com/lhotwll217/owner-operator/issues/195) Idle while still working | Parent `working` is the parent's last `stop_reason`. The subagent transcript is folded away. A background subagent after the parent's `end_turn` reads idle. `awaiting` can only fix this after the turn has already stopped, and only if Jev believes the last two messages. The scan does not read `~/.claude/sessions`. |
| [#197](https://github.com/lhotwll217/owner-operator/issues/197) Need You never clears | A `needs-you` write at the current `lastMessageAt` is preserved by `recordObservation`, is not re-asked until a new message, and is exempt from the age window. Process exit is invisible. |
| [#198](https://github.com/lhotwll217/owner-operator/issues/198) Running session appears late | With a watcher armed, the 15s tick does not rescan ([`monitor.ts`](../../src/session-monitor/monitor.ts)). Events debounce 600ms and parse only the named path. A Codex rollout that is not flushed as a matching `.jsonl` event stays invisible until something else forces a full scan. The observed row's `first_seen_at` was after `task_complete`. |
| [#199](https://github.com/lhotwll217/owner-operator/issues/199) Finished child under Working | `arrangeSessionState` emits the child in the parent's section. Documented in [`docs/widget.md`](../widget.md). |
| [#200](https://github.com/lhotwll217/owner-operator/issues/200) Stopped or failed session not Need You | Claude's interrupt marker is stored as a user message, and `deriveState` treats "user spoke last" as working. Codex `turn_aborted` keeps the event name and drops the reason. Claude's Stop hook does not run on a user interrupt, so a hook-only design still misses Esc unless the transcript marker is kept. |
| [#193](https://github.com/lhotwll217/owner-operator/issues/193) Blocked on an owner ask | A permission dialog sits on `stop_reason: tool_use`, so the row stays working, and Jev is not asked of a working row. A next-step card after `end_turn` is idle unless Jev scores it. Desktop `postTurnSummary` (`status_category: blocked`) is not read; [`claude-desktop-sessions.ts`](../../src/session-monitor/claude-desktop-sessions.ts) takes only the deep link. |
| [#215](https://github.com/lhotwll217/owner-operator/issues/215) Done comes back | Done wakes on any newer message: `<task-notification>`, the agent's own follow-up, Codex `<heartbeat>`, and a later delegated round into that child. |
| [#216](https://github.com/lhotwll217/owner-operator/issues/216) Parent stays "completion not confirmed" | The summary is model text. The child had no `threads` row, so the parent was enriched with `enriched_children: []` and a transcript that still predates the result. The run ledger already said completed. |
| [#217](https://github.com/lhotwll217/owner-operator/issues/217) Nested delegated agents absent | The widget lists `threads` only. Both children were in `agent_runs` and absent from `threads`. The scanner drops SDK transports and can miss the file until a full scan. Nesting never gets a row to attach. |
| [#156](https://github.com/lhotwll217/owner-operator/issues/156) False needs-you guidance | The `nextSteps` contract in that issue is gone. State now comes from Jev, whose true-case includes "handed to the owner to review". A wrong score sticks for the reasons in #197. The status summary is free text and can still sound like an order. |

## What Orca actually does

Orca is a terminal host. It installs a managed hook command per harness, and that command
POSTs the harness payload to a loopback HTTP server. Status is normalized in process.
Transcripts are a fallback and a content source, not the live state machine.

Checked out files, all at `57c9991`:

- Claude events it installs:
  [`claude-managed-hook-events.ts`](https://github.com/stablyai/orca/blob/57c9991c9821e68b4df1896d172b756c282012fb/src/main/claude/hooks/claude-managed-hook-events.ts).
  `SessionStart`, `UserPromptSubmit`, `Stop`, `StopFailure`, `SubagentStart`, `SubagentStop`,
  `TeammateIdle`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`,
  `PostCompact`, plus version-gated `Elicitation`, `ElicitationResult`, `SessionEnd`,
  `PostToolBatch`. Current Claude install does **not** include `Notification`. `Notification`
  is used by Qoder, Qwen, Grok, Droid, Copilot, and CodeBuddy.
- Claude normalization:
  [`claude-events.ts`](https://github.com/stablyai/orca/blob/57c9991c9821e68b4df1896d172b756c282012fb/src/shared/agent-hook-listener/providers/claude/claude-events.ts)
  and subagent roster updates in
  [`claude-lifecycle-events.ts`](https://github.com/stablyai/orca/blob/57c9991c9821e68b4df1896d172b756c282012fb/src/shared/agent-hook-listener/providers/claude/lifecycle/claude-lifecycle-events.ts).
  `UserPromptSubmit` / ordinary tool hooks → working. `PermissionRequest`, `Elicitation`, and
  `AskUserQuestion` on `PreToolUse` → waiting. `Stop` / `StopFailure` / manual `PostCompact` →
  done (turn ended). A live subagent roster holds the pane working after the lead's Stop
  ([`foldAgentLeadStatus`](https://github.com/stablyai/orca/blob/57c9991c9821e68b4df1896d172b756c282012fb/src/shared/agent-status/lifecycle/agent-lead-status-fold.ts)).
  Child tool hooks update the child roster and re-emit the cached lead. They do not replace
  the lead's state.
- Sticky permission, [PR #8311](https://github.com/stablyai/orca/pull/8311)
  (merge `745b164b94854ef6bd456ff69ce849c73e320247`, 2026-07-11). The server used to keep
  every Claude `waiting → working` transition. An answered `AskUserQuestion` then survived
  the next `Read` or `Bash`. The fix keeps that stickiness only when the previous event was
  a real `PermissionRequest` and the tool is not `AskUserQuestion`. The current form is
  [`shouldKeepClaudePermissionVisible`](https://github.com/stablyai/orca/blob/57c9991c9821e68b4df1896d172b756c282012fb/src/main/agent-hooks/server/server-claude-status-rules.ts).
  It also gives up the stickiness on an explicit new prompt, the owning child ending, a
  matching `PostToolUse`, or `PostToolBatch` (Claude can deny a permission with no Post hook).
  `applyNormalizedStatus` is the single write path
  ([`server-status-update.ts`](https://github.com/stablyai/orca/blob/57c9991c9821e68b4df1896d172b756c282012fb/src/main/agent-hooks/server/server-status-update.ts)).
- Codex events:
  [`codex-hook-definition.ts`](https://github.com/stablyai/orca/blob/57c9991c9821e68b4df1896d172b756c282012fb/src/main/codex/hooks/definitions/codex-hook-definition.ts)
  — `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`,
  `SubagentStart`, `SubagentStop`, `Stop`, `Interrupt`. Mapping in
  [`codex-state.ts`](https://github.com/stablyai/orca/blob/57c9991c9821e68b4df1896d172b756c282012fb/src/shared/agent-hook-listener/providers/codex/codex-state.ts):
  `Interrupt` and `Stop` → done with cancellation on interrupt; `PermissionRequest` and
  `AskUserQuestion` on `PreToolUse` → waiting. The comment in that file says `Interrupt` is
  the only hook an Esc-cancelled Codex turn fires (Codex 0.150+).
- Install without clobbering:
  [`applyManagedHooks`](https://github.com/stablyai/orca/blob/57c9991c9821e68b4df1896d172b756c282012fb/src/main/claude/hooks/hook-settings.ts)
  removes only commands whose path matches the managed script
  ([`createManagedCommandMatcher`](https://github.com/stablyai/orca/blob/57c9991c9821e68b4df1896d172b756c282012fb/src/main/agent-hooks/installation/commands/managed-hook-command-matching.ts)),
  appends one managed entry per event, and keeps a user hook's `async` flag if they opted the
  managed command into it. A user-owned status line is left alone. Unknown events are not
  installed on a CLI that does not know them; a failed version probe does not retire
  previously installed entries. Codex `hooks.json` cannot carry extra bookkeeping fields;
  Codex rejects them.
- Restart: the hook script re-sources `endpoint.env` on every event
  ([`hook-script.ts`](https://github.com/stablyai/orca/blob/57c9991c9821e68b4df1896d172b756c282012fb/src/main/claude/hooks/hook-script.ts)
  lines that `. "$ORCA_AGENT_HOOK_ENDPOINT"`). The file holds port, token, env, version
  ([`agent-hook-endpoint-file.ts`](https://github.com/stablyai/orca/blob/57c9991c9821e68b4df1896d172b756c282012fb/src/shared/agent-hook-listener/transport/agent-hook-endpoint-file.ts)).
  If the port or token is missing, the script spools the payload and exits 0. Permission
  hooks print `{}` first so an empty stdout does not fail the tool closed.
- Children: the sidebar indents `subagents` under the pane
  ([`agent-status-types.ts`](https://github.com/stablyai/orca/blob/57c9991c9821e68b4df1896d172b756c282012fb/src/shared/agent-status/contracts/agent-status-types.ts)).
  Lead state and child liveness fold into one pane state. A waiting child outranks a working
  lead. A working child holds a done lead open. That is one row plus indented children, not
  a second session index.
- No hooks / no PTY ownership: Orca classifies OSC titles and OSC 7501 program activity
  ([`terminal-title-observation.ts`](https://github.com/stablyai/orca/blob/57c9991c9821e68b4df1896d172b756c282012fb/src/main/runtime/terminal/output/terminal-title-observation.ts),
  [`agent-title-status.ts`](https://github.com/stablyai/orca/blob/57c9991c9821e68b4df1896d172b756c282012fb/src/shared/agent-status/title/agent-title-status.ts)).
  Comments in that tree say Esc posts no Claude hook, and Cursor's approval menu is a case
  no hook reports. Pi is not a Claude-shaped settings hook; Orca posts Pi extension events
  (`agent_start`, `tool_call`, `agent_end`, `ui_prompt_start` / `ui_prompt_end`) from
  [`pi-family-events.ts`](https://github.com/stablyai/orca/blob/57c9991c9821e68b4df1896d172b756c282012fb/src/shared/agent-hook-listener/providers/pi-family/pi-family-events.ts).
  OpenCode is a plugin (`permission.asked`, `session.idle`), not a settings.json hook.
  Cursor's installed events (`beforeSubmitPrompt`, `stop`, `preToolUse`, `postToolUse`, …)
  answer `permission: allow` and do not report an approval menu.

Do not copy Orca's pane model, its OSC scraper, or its `done` vocabulary. Owner Operator does
not own the PTY. OSC titles are not available here.

## Design

One harness-agnostic lifecycle, stored on the session, with a small adapter per harness.
The adapter's only job is to turn a harness payload into a lifecycle fact. The core does
not mention Claude or Codex.

Lifecycle facts:

| Fact | Projected state |
|---|---|
| `turn-started` | `working`. Creates the row if the transcript is not scanned yet. |
| `tool-started` | `working`, unless the tool is an owner question |
| `question-requested` | `needs-you`. The next unrelated `tool-started` clears it (PR 8311). |
| `permission-requested` | `needs-you`. Stays through later tool events until the same tool's `tool-finished`, a batch end, an explicit deny, a new owner prompt, or the owning child ending. |
| `tool-finished` | `working` |
| `turn-stopped` | `idle` if nothing live remains and the stop was not a failure |
| `turn-failed` | `needs-you` |
| `interrupted` | `needs-you` |
| `child-started` | that child `working`; parent `working` while any child is live |
| `child-stopped` | child `idle` or `needs-you` from the stop kind; parent recomputed |
| `session-ended` | `idle`, unless the last fact was an unanswered permission or question |

Owner Done is not a lifecycle fact. It stays `written_by=owner`. A lifecycle fact never
clears it. It clears only on `turn-started` whose prompt is the owner's own text: not
`INJECTED_OWNER_TEXT`, not a heartbeat, not a task notification, not an agent message, not
a prompt Owner Operator itself submitted for a delegated continuation. That is the #215 rule.

Mapping for the first two adapters:

| Fact | Claude Code | Codex |
|---|---|---|
| `turn-started` | `UserPromptSubmit`, `SessionStart` of a new session | `UserPromptSubmit` |
| `tool-started` | `PreToolUse` | `PreToolUse` |
| `question-requested` | `PreToolUse` or `PermissionRequest` whose tool is `AskUserQuestion`; `Elicitation` | `PreToolUse` on the question tool |
| `permission-requested` | `PermissionRequest` for a real tool | `PermissionRequest` |
| `tool-finished` | `PostToolUse`, `PostToolUseFailure`, `PostToolBatch` | `PostToolUse` |
| `turn-stopped` | `Stop`, manual `PostCompact` | `Stop` |
| `turn-failed` | `StopFailure` | `Stop` with an error payload, when the payload has one |
| `interrupted` | transcript marker `[Request interrupted` (Stop does not run) | `Interrupt` |
| `child-started` / `child-stopped` | `SubagentStart` / `SubagentStop` | `SubagentStart` / `SubagentStop` |
| `session-ended` | `SessionEnd`, when the installed CLI has it | — |

Harness-native sub-agents stay folded into the parent row. Their start/stop only change the
parent's liveness. They do not become widget rows. A **delegated run** is already a child
agent with its own session id; its hooks address that id, and the existing
`agent_runs.child_session_id` join supplies `parentThreadId`.

### Where events land

`POST /hooks/:harness` on the existing loopback gateway, same bearer as every other route,
body is the harness JSON. The daemon is the only writer.

On accept:

1. Append one row to `hook_events` (session id, harness, fact, tool name, tool-use id,
   parent session id, received at). This is the audit trail, not what the widget reads.
2. Upsert the session's live lifecycle on `threads`: last fact, last fact at, permission
   tool-use id if a permission is open, and a count of live harness-native children.
3. Publish the existing thread-changed invalidation. Clients refetch `/session-state`.

`recordObservation` may fill transcript fields (path, repo, topic, diff, link,
`lastMessageAt`). It must not write `state` for a session whose last fact is newer than the
transcript watermark. Today the poll write is what freezes Idle over a busy agent and what
freezes a stale Need You.

Projection order becomes: owner Done, owner snooze, hook lifecycle if present, else the
narrow transcript fallback below. Delete the Jev `awaiting` overlay. An active delegated
child still forces the parent to `working`, which the child's own `turn-started` will also
do once that child is admitted.

A child's **section** is its own state. It stays indented under the parent when they share
a section. When they do not, it is a root in its own section and keeps `parentThreadId` so
`oo` can still see the lineage. That is the #199 change. See the open question below.

### Transcripts after hooks

Keep the scanner, the watcher, enrichment's title and status summary, deep links, and diffs.
The status-summary prompt should say the summary names the state of the work and does not
instruct the owner. Need You is no longer inferred from that sentence.

Parent summaries already re-run when child evidence changes. That join has to include a
delegated child that exists in `agent_runs` even before its transcript is interesting, using
the run's `status` and `result_tail` when the transcript row is missing. That is the #216
fix, and it does not require a model to notice the ledger.

### Done stays done

`holdsDone` stops comparing raw `lastMessageAt`. The release is the owner's `turn-started`
only, as above. Agent messages, injected user-role text, heartbeats, and delegated
continuations update the summary and the ledger and leave Done in place.

### Delegated children

Two separate holes, and hooks only cover the second if we also admit the session:

- The monitor drops SDK transports, and ACP children are SDK sessions. Search still finds
  them. Admit a transcript when its id is `agent_runs.child_session_id`, regardless of
  `automatedTransport`.
- A hook `turn-started` for that id creates the thread immediately, with `parentThreadId`
  from the ledger, so the widget does not wait for the file watcher (#198, #217).

### Fallback where there is no hook

Owner Operator cannot scrape OSC titles. The fallback is the transcript `working` flag we
already compute, with two deletions:

- "user spoke last → working" is dropped. An interrupt marker and a Codex `turn_aborted`
  reason of interrupted or error become `needs-you`. A bare user message with no terminal
  signal stays `idle` until a hook or a real `working` flag says otherwise. That is the
  conservative reading of #200 for harnesses without an Interrupt hook.
- Jev no longer sets state. Unhooked harnesses do not get a model Need You. They show
  working or idle, plus deterministic question tools when the transcript names one
  (`AskUserQuestion`, the desktop next-step tool).

Pi can post the same lifecycle facts from a small extension (`agent_start`, `tool_call`,
`agent_end`, `ui_prompt_start` / `ui_prompt_end`), the way Orca already normalizes them.
That is a later adapter, not a settings.json hook. OpenCode's plugin events are the same
shape (`permission.asked`, `session.idle`). Cursor's hooks do not report the approval menu;
Cursor stays on the transcript fallback until a permission event exists. Antigravity, Grok
Build, and PostHog Code stay on the fallback.

### Install, uninstall, restart

`oo hooks status`, `oo hooks install`, `oo hooks uninstall`.

Install writes a script under `$OO_HOME/hooks/` and merges one managed command per event
into `~/.claude/settings.json` and Codex `hooks.json`. Match the managed script path, remove
only those commands, leave every other command in the file. Repeat installs replace the
managed command in place. Uninstall removes only those commands. Skip events the installed
CLI does not know. Do not install on a failed version probe's retire path.

The script prints `{}` and exits 0. It re-sources `$OO_HOME/hooks/endpoint.env` (port,
token, mode `0600`) on every event. If the daemon is down, it appends the body to a spool
under `$OO_HOME/hooks/spool/` and exits 0. Daemon startup drains the spool.

The daemon publishes `endpoint.env` when it binds. launchd already restarts it on a source
fingerprint change ([`docs/daemon.md`](../daemon.md)). In-flight harness processes pick up
the new port on their next event because they re-source the file. The script lives in
`OO_HOME`, not in the checkout, so a checkout switch does not point hooks at a dead path.

This is the same trust boundary as the daemon: loopback, bearer, mode `0600`. The token
does not go on the hook command line.

### What this deletes

After Claude and Codex hooks are authoritative:

- [`classifyStoppedSession`](../../src/agent/needs-you.ts) as a state writer, and the
  `awaiting` score with it. `needs-you.behavior.ts` goes with that call.
- `threads.awaiting_through_message_at` and `AWAITING_HOLDS_SQL`.
- The branch in `recordObservation` that freezes an enriched needs-you/idle forever.
- The branch in `appendModelDetailsIfFresh` that ignores attention while working. Hooks
  write state on their own path; enrichment writes title and summary only.
- `deriveState`'s "last role decides working vs idle" for any session that has a hook fact.
  The `working` flag remains only as the unhooked fallback.
- Jev as a way to notice harness-native sub-agents. `SubagentStart` / `SubagentStop` replace
  that question.

Kept: the scanner, enrichment titles and summaries, owner Done and snooze, the `agent_runs`
ledger, `arrangeSessionState` (with the section rule changed), the widget as a pure client.

## Bug map

| Issue | Verdict |
|---|---|
| #195 | Fixed for Claude and Codex by `child-started` holding the parent `working` after the lead's Stop. Unhooked harnesses stay on the transcript `working` flag, which is the current bug. |
| #197 | Fixed for hooked sessions: a later `turn-stopped`, `tool-finished`, or `session-ended` replaces needs-you, and a poll cannot put it back. Rows that already stuck, with no future hook, need a one-time decision (open question). |
| #198 | Fixed by `turn-started` inserting the row. The watcher stays for transcript content. |
| #199 | Fixed by the section rule, independent of hooks. A hook-accurate child state is what makes the new section true. |
| #200 | Partly. Codex `Interrupt` and `StopFailure` are hooks. Claude Esc does not run Stop; the transcript interrupt marker has to stay. A failed turn with no hook payload still depends on that marker. |
| #193 | Fixed for Claude permission dialogs and `AskUserQuestion`, including mid-turn, because the hook sets needs-you while the transcript still says `tool_use`. Codex `PermissionRequest` is the same fix. Cursor's approval menu is not. |
| #215 | Fixed by releasing Done only on an owner `turn-started`. |
| #216 | Partly. Admitting the child and feeding `result_tail` into the parent sample removes the empty-children summary. The summary is still model text; a hook does not write it. The parent row's *state* becomes working or idle from the child's hooks without waiting for that sentence. |
| #217 | Fixed by admitting delegated SDK sessions and creating the row on the child's `turn-started`, then the existing `parentThreadId` join. Hooks do not fix a child the scanner keeps dropping if we forget the admit rule. |
| #156 | Fixed as a state bug by deleting the Jev state writer. Summary wording can still sound like an order until the prompt forbids that. The old `nextSteps` contract is already gone. |

## Pull requests

Each one is verifiable with fixture HTTP posts and a temp `OO_HOME`. No live model call, no
macOS UI.

1. **Claude hooks feed Need You.** Managed install/uninstall, `POST /hooks/claude`,
   `endpoint.env` re-source, spool drain. Facts: `turn-started`, `question-requested`,
   `permission-requested`, `tool-started`, `tool-finished`, `turn-stopped`. Hook state wins
   over a following poll. Tests: a settings file with a user `PreToolUse` command is
   unchanged except for the one managed entry, and uninstall removes only that entry;
   `PermissionRequest` then an unrelated `PreToolUse` stays needs-you; `AskUserQuestion`
   then `PreToolUse` of `Read` becomes working; a poll that would have derived idle does
   not overwrite a live permission; a script pointed at a dead port spools, and the next
   daemon start applies it. This is [#193](https://github.com/lhotwll217/owner-operator/issues/193)
   for Claude.

2. **Children and interrupts.** `SubagentStart` / `SubagentStop` hold the parent working
   (#195). Child section follows the child (#199), covered by `arrangeSessionState` tests
   the widget already shares. Codex adapter with `Interrupt` (#200 for Codex). Claude
   interrupt marker maps to needs-you even when the last role is user. Tests are fixture
   sequences plus one scan fixture with `[Request interrupted`.

3. **The row exists at prompt submit.** `turn-started` inserts a thread before any
   transcript file, and a later scan attaches the path without changing state (#198).
   Same for Codex. Test: post a session id with no file, `GET /session-state` returns it
   as working.

4. **Done ignores non-owner messages** (#215). Tests: task-notification, heartbeat, assistant
   message, and a delegated continuation leave Done; an owner `UserPromptSubmit` clears it.

5. **Delegated children and the deletion.** Admit `child_session_id` transcripts despite
   `automatedTransport`. Parent enrichment reads the run row when the child thread has no
   sample yet (#216, #217). Remove the Jev state writer, the awaiting column's effect, and
   the freeze in `recordObservation` (#156, #197). Tests: an SDK-entrypoint fixture with a
   matching `agent_runs` row appears under its parent; a completed child changes the
   parent's enrichment inputs; a stopped session with no hook fact is idle, not needs-you.

## Open questions

These change the product, so they are Luke's:

- A finished child of a working parent: leave it indented under Working but marked idle, or
  move it to Idle as this plan does?
- For Pi, Cursor, OpenCode, Antigravity, Grok Build, and PostHog Code, is "no model Need
  You" acceptable until each has an adapter? The alternative is keeping Jev as a fallback,
  which keeps #156 and #197 for those harnesses.
- Install hooks from onboarding, or only when the owner runs `oo hooks install`? The install
  edits `~/.claude/settings.json` and Codex `hooks.json`.
- The rows already stuck in Need You: leave them until the owner marks Done, or clear any
  needs-you that has no unanswered permission or question the next time the daemon starts?
- A delegated child blocked on a permission: needs-you on the child only, or also on the
  parent so it sorts to the top while the parent is otherwise working?

## Not verified here

The cloud agent is Linux. Not run: macOS LaunchAgent kickstart across a daemon restart,
Claude Code and Codex actually invoking the hook script from the owner's home, FSEvents
behavior behind #198, or the Swift widget. The session ids in the issues live on Luke's
machine; this checkout does not contain those transcripts, so the SDK-entrypoint explanation
of #216 and #217 is the admission rule that produces that shape, not a reading of those
two files.
