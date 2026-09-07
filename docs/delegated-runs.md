---
title: "Sub-agents and delegated runs"
summary: "Owner Operator-issued sub-agents: tracking boundaries, lifecycle, harness seam (ACP), retry, and resume"
read_when:
  - Understanding sub-agents, child agents, or delegated work
  - Determining whether child work is tracked in the run ledger, session state, or widget
  - Launching, inspecting, or debugging a delegated agent run
  - Changing the run lifecycle, the ACP launcher, or how runs are presented
---

# Sub-agents and delegated runs

**Sub-agent** is the broad relationship: an agent launched to help another agent. Owner Operator
uses the narrower term **delegated run** for a child execution its daemon issues and owns through
the AgentRun launch path. `delegate_agent` is the Operator-facing route; authenticated Gateway
clients can use the same path directly. The child is a session of its selected harness; the
delegated run is OO's durable lifecycle record for that execution. The explicit supported roster
lives in [`AgentRunHarness`](../packages/core/src/agent-runs.ts).

This distinction matters because a harness can launch its own native sub-agents without OO.
Those helpers are sub-agents, but they are not OO-delegated runs and never enter OO's run ledger.
A **schedule run** is a separate domain object; the delegated-run name does not imply that
schedules or triggers launch sub-agents.

Owner Operator launches child coding agents as durable, daemon-owned
**delegated runs** ([#69](https://github.com/lhotwll217/owner-operator/issues/69)). A run is
tracked with explicit retry/resume relationships, durable status, controls, and presentation — never inferred from
transcript activity. The domain terms live in [CONTEXT.md](../CONTEXT.md).

The daemon owns execution; the executor extends the scheduler's durable-run substrate rather
than adopting an orchestration framework. The child process is reached over the
[Agent Client Protocol](https://github.com/agentclientprotocol/agent-client-protocol) via
pinned [`acpx`](inspiration.md) — one protocol client for every harness.

```text
Operator (delegate_agent / manage_agent_run tool)
        │  Gateway HTTP
   AgentRunExecutor ──── State (agent_runs ledger) ──── SSE agent-run.changed
        │
   ACP launcher (acpx) ──── child harness session
```

## Tracking boundary

Run ownership, transcript observation, and widget visibility are separate:

| Work | `agent_runs` ledger | `/session-state` | Widget |
|---|---|---|---|
| Child launched through OO's AgentRun path (`delegate_agent` or Gateway) | Always; this is the canonical OO-issued marker | When the scanner admits its harness transcript, joined by `child_session_id` | Always represented in Agent state; also appears as a normal session row when present in session state |
| Harness-native sub-agent | Never | Harness-dependent: it may be folded into its parent, excluded as automated work, or admitted as an ordinary session | Mirrors session state; it has no OO lineage |
| Any agent launches a separate supported coding CLI | Only if the launch went through `delegate_agent` | Its transcript may be discovered and admitted normally | An ordinary row, without OO lineage |
| Owner-origin Owner Operator conversation | Not a child run; its id may be recorded as a run's parent | Admitted from the product-owned transcript store as an ordinary root | Ordinary root with observed delegated children nested beneath it |

The ledger relationship is authoritative: a session is OO-delegated when its id matches an
`agent_runs.child_session_id`. Do not infer ownership from process ancestry, transcript location,
or activity. [`scan-active-transcripts.mjs`](../src/session-monitor/scan-active-transcripts.mjs)
owns the harness-specific admission, folding, and automated-session policy; [sessions.md](sessions.md)
owns transcript identity and discovery.

## Lifecycle

`pending → running → { completed | failed | cancelled | interrupted | lost }`.

- **Terminal states are monotonic.** Retry and resume each create a new row; reopening a terminal
  row would erase one paid turn's history. Retry links the new row to the unsuccessful run whose
  task it reruns; resume links the new row to the completed run after which it sends a new task.
  The exact ledger-column contract lives in
  [schema docs](../src/state/schema-docs.ts). The
  [domain contract](../packages/core/src/agent-runs.ts) derives runtime turn intent from those
  relationships and fails closed when either is inconsistent.
- **Retry and resume are distinct controls.** Retry reruns the same task after `failed`,
  `interrupted`, or `lost`; resume requires a new task after `completed`. The
  [tool schema](../src/agent/tools/manage-agent-run.ts) owns their inputs, while the
  [domain contract](../packages/core/src/agent-runs.ts) owns pure eligibility.
- **The protocol turn result finalizes a run**, never process exit alone. A completed ACP turn
  is `completed`; a cancelled turn is `cancelled`; a turn error or child death is `failed`.
- **`interrupted`** is retryable: a graceful daemon shutdown mid-run, or a restart reconciling a
  row left `running` by a crash, lands here. The child identity is preserved for retry.
- **`lost`** is assigned only by the reconciliation sweep: a `running` row with no live
  in-process turn and no activity inside the grace window. Liveness is the executor's active-turn
  set plus durable rows — persisted metadata alone never keeps a run alive, and a live turn is
  never reclaimed.

## Live state and clients

The ledger is a live, durable projection—not just a final result:

1. Launch persists and returns a `pending` row.
2. Queue claim records `running` and `started_at`.
3. ACP session creation records `child_session_id` and `acpx_record_id`.
4. Non-thought ACP text, status, and tool-call events replace `activity` with a bounded preview
   and advance `last_activity_at`. This is latest activity, not a durable event log.
5. Turn completion records the terminal status, `finished_at`, bounded `result_tail`, and `error`.

Every successful mutation publishes an `agent-run.changed` invalidation. Gateway SSE deliberately
carries only the event kind; clients refetch `/agent-runs` or `/agent-runs/:id` for durable truth.
A client that renders activity should coalesce refetches because a verbose child can produce many
ACP deltas.

Client behavior follows the same invalidation/refetch contract:

- **Interactive TUI:** each open parent thread lists its complete fleet by `parentThreadId` before
  opening one Gateway subscription, then lists again after attachment to close the snapshot gap.
  Initial and replacement SSE connections invalidate the fleet. `ParentRunSession` coalesces
  invalidations with an in-flight/dirty refetch rule. Its shared view drives the literal
  `Agent state` footer and the `/agent-state` picker. State—not this client adapter—projects the
  parent as working while a delegated child is pending or running.
- **Headless chat:** opening or resuming a parent thread starts the same `ParentRunSession` and Pi
  completion adapter without the footer or picker. Initial completion delivery is unbatched and
  awaited before the explicit prompt, and shutdown drains current delivery before closing the
  subscription, so a short-lived process cannot strand a retained terminal row.
- **Widget:** its live delegated-run client behavior is owned by [Widget](widget.md).
- **RPC:** Owner Operator does not expose a Pi RPC frontend today. A future conversation UI can
  use RPC for turns and tool events, but background runs should remain a Gateway resource so they
  outlive the tool call, parent conversation, and UI process.

The reusable status categories, bounded detail, ordering, controls, and completion envelope live
in the dependency-free `@owner-operator/core/agent-state` export. Gateway subscriptions, Pi UI,
and terminal styling are adapters over that contract.

## Execution

- **Background by default.** `delegate_agent` records the durable `pending` row and returns
  immediately; the parent session is never frozen. The result is carried by the ledger, not the
  parent tool call, and completion arrives through the parent subscription. The Operator does not
  poll after delegation; `/agent-state` owns liveness. Status reads remain only for explicit
  owner requests. The only blocking wait is `delegate_agent`'s opt-in `waitSeconds` at launch;
  `manage_agent_run` has no wait action, so an in-flight run can never lock the parent turn.
- **Retry and resume re-enter the ordinary lifecycle.** The
  [executor](../src/agent-runs/executor.ts) owns row creation and authoritative runtime validation;
  [ACP launcher](../src/agent-runs/acp-launcher.ts) proves exact available record/session identity
  before sending the turn. For resume, the
  [environmental projection](../src/agent-runs/agent-state-projection.ts) also prevents clients from
  offering a control for an unavailable workspace. Both controls fail closed rather than
  substituting a fresh context.
- **Workspace follows the root's durable selection.** Immediately before an omitted-cwd launch,
  `delegate_agent` resolves the exact parent thread through the Gateway, using Pi's active
  tool-context cwd as the fallback. A worktree selected earlier in the same model turn therefore
  wins before the post-turn runtime rebind; an unavailable or mismatched selection fails closed.
  An explicit absolute child cwd remains exact, and an explicit relative cwd resolves from the
  active tool-context cwd. The initial child row records the resolved absolute path, and
  retry/resume copy that immutable cwd from the original run lineage.
- **Concurrency** is capped (default 3 running daemon-wide); launches beyond the cap stay
  `pending` and start as slots free, claimed one row at a time under the cap in a single
  transaction so a race can never overshoot.
- **Owner Operator owns the deadline.** The executor aborts on its own per-run timeout so a
  launcher-side timeout after partial output can never read as success.
- **Depth is 1**, enforced not just structurally. The executor rejects a launch whose parent
  thread is itself a delegated run's child (`AGENT_RUN_MAX_DEPTH`). Every child prompt also tells
  the child to complete the work directly without nested or background agents, including
  harness-native sub-agents.
- **Model** is pinnable per run (`delegate_agent`'s `model`), threaded to the child through ACP
  session options, and a caller pin always wins. When omitted, `delegate_agent` resolves the
  owner-approved per-harness baseline from [launch configuration](../src/agent-runs/launch-config.ts)
  before creating the durable row. With no approved baseline it asks instead of inheriting an
  ambient harness default or inventing a product default.
- **Reasoning effort** is pinnable per run (`delegate_agent`'s `effort`), including explicit
  `null`. Its canonical vocabulary lives in [`AgentRunEffort`](../packages/core/src/agent-runs.ts);
  resolution follows the same caller pin then approved-baseline order as model and lands in the
  durable row before launch. Legacy rows retain `NULL`; clients omit unknown effort instead of
  displaying a placeholder.
- **Effort application** is owned by the [ACP launcher](../src/agent-runs/acp-launcher.ts), which
  resolves only session-advertised config options and confirms the exact model plus any non-null
  effort before sending the task. The durable `effort_applied` field distinguishes recorded
  intent from confirmed application; its contract lives in [schema docs](../src/state/schema-docs.ts).
  Confirmed model and supported effort are recorded separately from the prelaunch request fields.
  Public `AgentRun` values expose one discriminated
  `harnessIdentity`: unobserved, model-only, effort-only, or model-and-effort. Empty status and
  wholly unsupported status decode as unobserved, so contradictory public representations cannot
  be constructed. The three SQL columns are only that value's storage encoding.
- **Process ownership is explicit on POSIX.** Before `acpx` can spawn, the launcher persists a
  lease and puts its unguessable id on a stable Owner Operator wrapper's command line. Normal
  completion closes the ACP process tree, then confirms every PID from the original tree is gone
  before releasing its lease; daemon startup reaps only orphaned trees whose
  live wrapper path and lease id both match. It fails closed on unavailable process listings and
  never claims an unowned harness or `acpx` process.

## Harness details

Before an implicit delegation, the Operator loads the bundled
[`select-harness-for-delegation`](../src/agent/skills/select-harness-for-delegation/SKILL.md)
skill. The skill owns preference interpretation, baseline and owner-defined task-role classification,
current-details consultation, exact identity selection, approved-baseline consent, and concise
identity reporting. A complete owner-supplied harness/model/effort choice—including explicit null
effort—bypasses selection and reaches `delegate_agent` unchanged. The permanent product prompt owns
only that invocation and precedence rule.

`get_harness_details` returns one namespaced snapshot: raw owner preferences, launch-authoritative
ACP capabilities, and provider account/allowance observations remain separate. Every supported
harness capability row comes from a disposable session through the same leased ACPX launch seam as
delegation and includes the complete advertised `SessionConfigOption[]` plus exact ACPX, adapter,
backend, resolution-source, and observation-time provenance. Provider-specific model projections
are not launch truth. [`src/agent-runs/harness-details.ts`](../src/agent-runs/harness-details.ts)
joins the isolated sources; the private
[ACP observer](../src/agent-runs/harness-details-acp-observer.ts) owns initialization, status
validation, timeout, termination, and throwaway-store cleanup. The tool remains a thin adapter.

Capability and account observation is read-only and ephemeral. Owner preferences live only at
`$OO_HOME/workspace/user-harness-preferences.md`; workspace setup seeds that file when absent and
never overwrites it.

- **No capability truth is stored.** No cache, polling, provider registry, or failure ledger. Every call
  re-observes, and a snapshot is only true as of its `observedAt`.
- **`null` means unknown; `[]` means observed-and-none.** A fact the harness exposes no surface for
  stays `null` rather than being inferred from documentation or pricing pages. Claude Code's ACP
  session supplies capabilities, while its plan and allowance remain unknown.
- **One source cannot erase another.** Each ACP harness and provider account surface is observed
  independently. A capability failure lands in that harness row and cannot erase owner
  preferences, another harness, or an account observation.
- **Percentages are subscription allowance**, never token counts and never list-price figures.
- **No selection happens here.** The snapshot reports facts and ranks nothing; choosing a
  harness or model is the caller's decision.

Codex account plan and allowance facts come from its first-party `codex app-server` JSON-RPC
surface. Its model list is not used as capability evidence; the disposable Codex ACP session owns
that namespace. The leased wrapper clears inherited `CODEX_PATH` for supported Codex ACP launches,
so the adapter always executes its package-lock dependency and the reported backend version cannot
describe a different binary than the session used.

Cursor account and authentication facts come from `cursor-agent about` and `cursor-agent status`.
Cursor speaks ACP natively — the capability observer and launcher run the same resolved local CLI
as `cursor-agent acp`, with no adapter package in between, and report that path-resolved binary's
version. The broader `cursor-agent models` account catalog is deliberately not read. Cursor
allowance windows have no CLI surface and stay honestly unknown. The CLI is signed into
whatever Cursor account is active on the machine; a delegated run bills that account and sends
the task's code to it. A launch can also fail with the server's own `ActionRequiredError` (for
example an unacknowledged data-retention prompt); the run's failure record carries that message
verbatim as an owner action.

Baseline-candidate discovery remains opt-in. It projects the unpinned disposable ACP observation's
current model and thought-level option as a *candidate*. A candidate is never saved: persisting a
delegated default requires explicit owner approval and is owned by the
[launch configuration](../src/agent-runs/launch-config.ts).

`manage_delegated_baseline` is the narrow consent seam. `propose` performs initial discovery or a
refresh and only compares the ephemeral candidate with the current approval. `approve` stores the
exact owner-approved model and nullable effort in one atomically replaced file per harness under
`delegated-baselines/`, separate from the owner-edited user harness preferences and the run ledger.
Declining a proposal performs no write.

The probe session runs from `OO_HOME`, never the caller's working directory, so project-local
harness config cannot contaminate a global candidate. The active probe owns termination: timeout
requests close, then verifies the leased wrapper tree is absent before releasing its process lease
and disposable session directory. Failed verification retains both the lease and probe session
directory as termination evidence for startup orphan reaping; neither is presented as a usable
baseline candidate.

### OpenCode

`opencode` and `opencode2` are distinct delegation and baseline identities. Both run their installed
native `acp` command through ACPX's existing registry override, using PATH followed by
`~/.opencode/bin` and `~/.local/bin`. Stable retains the `opencode` ACP agent identity; OO resolves
the installed executable instead of ACPX's default `npx -y opencode-ai acp` so inspection can report
the actual path and version without downloading a backend. A missing `opencode2` fails explicitly.
The [V2 npm launcher](https://github.com/anomalyco/opencode/blob/898692af267059a743b7827e206d84df7a787a9b/packages/cli/bin/opencode2.cjs#L33-L39)
honors `OPENCODE_BIN_PATH`. OO clears it for both identities during launch and version checks;
this is not a claim that the stable native binary reads that variable. Provider accounts and
allowance stay unknown.

Inspection and launch both check the CLI's version signature: [stable reports bare semver](https://github.com/anomalyco/opencode/blob/16747470f976aca3d362ad730bcd3fe82ecc2c9a/packages/opencode/src/index.ts#L48-L52); the
official V2 CLI reports `opencode2 v<semver>` ([command identity](https://github.com/anomalyco/opencode/blob/898692af267059a743b7827e206d84df7a787a9b/packages/cli/src/commands/commands.ts#L11-L39),
[version dispatch](https://github.com/anomalyco/opencode/blob/898692af267059a743b7827e206d84df7a787a9b/packages/cli/src/index.ts#L86-L92)).
Provenance includes the requested executable path, its real path and the verbatim version output.
A stable binary aliased as `opencode2` is rejected. This trusts the installed executable's output:
an arbitrary wrapper can lie about its identity or change after inspection. It is not binary
attestation. Unknown version signatures fail explicitly rather than being labeled V2 by filename.

The observer exposes initialize capabilities retained by ACPX. Both
[stable](https://github.com/anomalyco/opencode/blob/16747470f976aca3d362ad730bcd3fe82ecc2c9a/packages/opencode/src/acp/service.ts#L112-L135)
and V2 advertise continuation. V2's source provides the
[executable](https://github.com/anomalyco/opencode/blob/898692af267059a743b7827e206d84df7a787a9b/packages/cli/package.json#L1-L12),
[native ACP handler](https://github.com/anomalyco/opencode/blob/898692af267059a743b7827e206d84df7a787a9b/packages/cli/src/commands/handlers/acp.ts#L1-L39),
and [load/configuration contract](https://github.com/anomalyco/opencode/blob/898692af267059a743b7827e206d84df7a787a9b/packages/cli/src/acp/service.ts#L185-L299).
Source support and advertised models do not establish local installation, authentication, model
entitlement, or successful inference. Exact model IDs and nullable effort use the shared selection
contract above; no OpenCode-specific model catalog or effort translation is applied.

For OpenCode controls, OO additionally reads the same child's retained ACPX initialize capabilities
before offering or creating retry/resume. Either `loadSession: true` or an advertised
`sessionCapabilities.resume` object permits continuation, matching ACPX's preference for resume.
Missing, mismatched or unreadable records, or absence of both methods, fail closed without a new
run row. This reuses ACPX 0.13.2's [file store](https://github.com/openclaw/acpx/blob/fd173f04aa1b56f9e3f5ca5190c034ddcae28792/src/runtime/public/file-session-store.ts#L9-L45)
and [record encoding](https://github.com/openclaw/acpx/blob/fd173f04aa1b56f9e3f5ca5190c034ddcae28792/src/session/persistence/serialize.ts#L1-L45);
there is no second capability store or ledger migration. The synchronous environment check keeps
eligibility and row creation together. At execution ACPX checks the current backend again, and OO
rejects a changed child identity. A capability change since the retained observation can still
fail the new attempt; the roster's boolean is only a harness-family allowance.

### Manual baseline-consent proof

Use a disposable home so discovery and approval cannot touch the owner's normal configuration.
This is a paid, real-harness check; it is not part of `npm test`.

```sh
PROOF_USER_HOME="$(mktemp -d)"
PROOF_OO_HOME="$PROOF_USER_HOME/.owner-operator"
HOME="$PROOF_USER_HOME" OO_HOME="$PROOF_OO_HOME" ./oo
```

Complete setup for the real harness credentials in that isolated home. Then use one saved headless
conversation for the consent loop (replace `claude-code` with the exact supported harness identity
being validated):

```sh
HOME="$PROOF_USER_HOME" OO_HOME="$PROOF_OO_HOME" ./oo "Propose the current unpinned claude-code delegated baseline. Do not approve or launch anything."
HOME="$PROOF_USER_HOME" OO_HOME="$PROOF_OO_HOME" ./oo --continue "I approve exactly the proposed model and effort. Persist it, then delegate a child that replies OO_BASELINE_PROOF_OK using the approved baseline explicitly."
HOME="$PROOF_USER_HOME" OO_HOME="$PROOF_OO_HOME" ./oo --continue "Refresh the claude-code baseline candidate, show the candidate and current approval, but do not approve the refresh. I decline any replacement."
```

Inspect the transcript named on stderr and
`$PROOF_OO_HOME/delegated-baselines/<harness>.json` for the harness being proven. The first turn
must show an unpinned
candidate with no baseline file or delegated launch. The second must show explicit owner approval,
the persisted exact nullable identity, and a later run row reporting the same harness/model/effort.
The third must show a fresh proposal while the file remains byte-for-byte unchanged. Remove only
the printed disposable directory after retaining any sanitized proof needed for acceptance.

## Permissions

Each child honors its **own harness's** permission system, exactly as any other session of that
harness on the owner's machine. Owner Operator builds no cross-harness permission layer and never
escalates: the ACP launcher is deny-by-default for non-read asks and fails a turn on the first
unapprovable change ask (recorded as a run failure) rather than continuing degraded, so the
owner's harness config stays the real gate. The exact `acpx` permission settings live in
[`src/agent-runs/acp-launcher.ts`](../src/agent-runs/acp-launcher.ts). (Privacy blacklist enforcement
for foreign-harness children is a separate OS-sandbox concern, not a permission-seam concern.)

## Lineage and presentation

A run row carries `parent_thread_id`. When the monitor observes the child's transcript through
its ordinary scan path, the observed thread joins to its `agent_runs` row by identity
(`child_session_id`), so the session-state projection exposes `parentThreadId`. This is an
identity join, never inference from transcript-file growth. When the monitored OO parent is also
visible, the widget nests the child beneath that exact root. While any child is pending or running,
State projects the root as `working` and excludes it from needs-you enrichment and schedule inputs.
Once all children are terminal, the transcript-derived root state applies again. The ledger record
remains the canonical child provenance.

In the terminal, `pi-tool-display` owns the compact `delegate_agent`/`manage_agent_run` call and
result components, with raw results available through Pi's ordinary expansion. A successful
delegation also persists one neutral launch line derived from the run row; the existing completion
message persists the other inline lifecycle moment. The parent-scoped live view is separate: the
footer shows queued, running, and attention
counts only while one exists and clears whenever the Gateway connection is unavailable;
`/agent-state` orders attention before active and recent terminal runs, then shows bounded task,
harness, model and known effort, glyph-plus-text status, elapsed time, activity, exact retry/resume
relationships, and only currently valid controls. Retry is available only for unsuccessful runs;
resume is available only for completed runs and collects the required new task before mutation.
Cancellation confirms before mutation.

Terminal completion behavior is defined at four linked seams: the browser-safe
[completion envelope](../packages/core/src/agent-state.ts), parent-scoped
[terminal reconciliation](../src/agent-runs/parent-run-session.ts), the
[Pi custom-message adapter](../src/agent-runs/agent-run-completion.ts), and its model-free
[saved-session integration contract](../test/agent-run-completion.integration.test.ts).
Queued delivery and bounded retry/recovery behavior are owned by the
[terminal reconciliation](../src/agent-runs/parent-run-session.ts) and
[Pi custom-message adapter](../src/agent-runs/agent-run-completion.ts). Bounded child evidence
is normalized to remove terminal control and bidirectional override characters before any adapter
receives it.

## State

The `agent_runs` table is the durable ledger; its columns are documented once in
[`src/state/schema-docs.ts`](../src/state/schema-docs.ts) and inspectable through `query_database`.
`acpx` session records and process leases live under `~/.owner-operator/agent-runs/` (relocated
out of the system tmpdir so restart reconciliation, safe orphan reaping, retry, and resume retain their
identities across daemon restarts).
