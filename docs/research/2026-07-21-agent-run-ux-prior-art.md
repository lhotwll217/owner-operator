# Agent run UX — prior art (2026-07-21)

Research for issue #75. Sources: local checkouts at the paths and SHAs below, plus Owner Operator
`src/` and `docs/`. No web searches, no synthesised snippets.

| Checkout | SHA | License |
|---|---|---|
| `./codex` | `0b175e6439a8608ba7726ee153fd8590619e8f34` | Apache-2.0 |
| `./openclaw` | `372b527da4a1cee5b819e7852f6e26ef11160e85` | MIT |
| `./pi-upstream` | `65dd2e0ed6c71bd61d698353c29f2de24968bf76` | — |
| `./onurpi` | `1f056a3f2632404929231a5baeec968139e705c1` | — |
| `./pi-subagents` | `e658b40fe72d599df231b5d59ffec40d66f576fa` | — |
| `./pi-interactive-subagents` | `c100577ebf7393a11d098ad9810ec6c269dcfc30` | — |

---

## 1. What OO lacks today

From [`docs/delegated-runs.md`](../delegated-runs.md#live-state-and-clients) (current):

> **Interactive TUI:** `delegate_agent` returns immediately and renders that launch snapshot
> (normally `pending`). The row does not subscribe after the tool call ends.
> `manage_agent_run status|wait` renders a later snapshot on demand.
>
> **Widget:** receives the SSE invalidation but currently refetches only `/session-state`,
> not `/agent-runs`, so it does not render ledger activity or outcomes.
>
> The durable rows, list/get/control routes, SSE invalidation, and `GatewayApi.subscribe`
> are the existing seams for a live TUI or widget panel. **The missing piece is a
> client-owned subscribe → refetch → render projection.**

The current `delegate_agent` / `manage_agent_run` tools render one compact line via
`formatAgentRunRow` (`src/shared/oo-presentation.ts:229`):

```
harness · task · state · detail · elapsed
```

That line is a dead snapshot: it never updates after the tool call closes. No fleet view, no
inline activity, no completion notification, no steer/cancel surface.

---

## 2. Prior-art matrix

### 2A. Codex TUI (Rust) — `./codex`

**a) Inline high-signal reasoning / activity (implemented)**

`StatusIndicatorWidget`
([`codex-rs/tui/src/status_indicator_widget.rs:46`](https://github.com/openai/codex/blob/0b175e6439a8608ba7726ee153fd8590619e8f34/codex-rs/tui/src/status_indicator_widget.rs#L46-L61))
renders one live row above the composer. It owns: animated header (`"Working"`), wrapped
details (up to 3 lines), elapsed timer, interrupt hint. `set_status` / `set_status_header`
keep it to one moving surface; no accumulating wall.

`STATUS_DETAILS_DEFAULT_MAX_LINES = 3` and `DETAILS_PREFIX = "  └ "` bound detail rendering.
([`status_indicator_widget.rs:35-36`](https://github.com/openai/codex/blob/0b175e6439a8608ba7726ee153fd8590619e8f34/codex-rs/tui/src/status_indicator_widget.rs#L35-L36))

**b) Hiding raw tool args / results / retry noise (implemented)**

`flush_answer_stream_with_separator`
([`streaming.rs:34-36`](https://github.com/openai/codex/blob/0b175e6439a8608ba7726ee153fd8590619e8f34/codex-rs/tui/src/chatwidget/streaming.rs#L34-L36))
hides the inline status indicator when content commits.
`maybe_restore_status_indicator_after_stream_idle` restores it only when all queues drained
and the turn is still running — preventing flicker during normal output.

**c) Compact activity preview (implemented)**

`AgentStatusHistoryCell`
([`tui/src/app/agent_status_feed.rs:22`](https://github.com/openai/codex/blob/0b175e6439a8608ba7726ee153fd8590619e8f34/codex-rs/tui/src/app/agent_status_feed.rs#L22-L62)):
bounded preview of sub-agent activity — 3 preview lines, 6 items, 240 graphemes. Fires when
`/agent` is invoked.

`activity_summary`
([`agent_status_feed.rs:135`](https://github.com/openai/codex/blob/0b175e6439a8608ba7726ee153fd8590619e8f34/codex-rs/tui/src/app/agent_status_feed.rs#L135-L197))
maps every `ThreadItem` variant to a one-line label:

| Event | Label |
|---|---|
| Command execution | `$ cmd` |
| File change | `Updated N file(s)` |
| MCP call | `MCP server/tool` |
| Spawn agent | `Spawned an agent` |
| Wait for agent | `Waited for an agent` |
| Resume agent | `Resumed an agent` |
| Web search | `Web search: query` |
| Context compaction | `Compacted context` |

Unknown variants are elided, not surfaced as noise.

**d) Persistent background / sub-agent state (implemented)**

`AgentPickerThreadEntry`
([`multi_agents.rs:34`](https://github.com/openai/codex/blob/0b175e6439a8608ba7726ee153fd8590619e8f34/codex-rs/tui/src/multi_agents.rs#L34-L45))
tracks nickname, role, path, `is_running`, `is_closed`. `Alt+←/→` cycles agents.
`agent_picker_status_dot_spans` renders `•` green for live, `•` plain for closed.
([`multi_agents.rs:75`](https://github.com/openai/codex/blob/0b175e6439a8608ba7726ee153fd8590619e8f34/codex-rs/tui/src/multi_agents.rs#L75-L82))

`CollabAgentTool` history cells surface
`SpawnAgent | SendInput | ResumeAgent | Wait | CloseAgent` as compact one-liners in the
transcript.
([`tool_lifecycle.rs:117`](https://github.com/openai/codex/blob/0b175e6439a8608ba7726ee153fd8590619e8f34/codex-rs/tui/src/chatwidget/tool_lifecycle.rs#L117-L145))

**e) Startup failure surfacing (implemented — MCP-specific)**

`McpStartupStatus { Starting | Ready | Failed { error } | Cancelled }`
([`mcp_startup.rs:18`](https://github.com/openai/codex/blob/0b175e6439a8608ba7726ee153fd8590619e8f34/codex-rs/tui/src/chatwidget/mcp_startup.rs#L18-L23)).
The widget buffers startup rounds and detects stale post-finish updates, preventing a restart
from reopening `"Booting…"`. The pattern applies directly to ACP child launch failures.

**f) Nonblocking parent (implemented)**

`TurnLifecycleState.agent_turn_running` / `start()` / `finish()`
([`turn_lifecycle.rs:29-46`](https://github.com/openai/codex/blob/0b175e6439a8608ba7726ee153fd8590619e8f34/codex-rs/tui/src/chatwidget/turn_lifecycle.rs#L29-L46))
keep the parent's own lifecycle independent of child activity. Sleep inhibitor is tied to
parent turn state only.

**Reusable patterns (Codex is Rust; not importable):**
- One animated row: header + details (3-line max) + elapsed + interrupt hint.
- Activity label taxonomy per tool-call event.
- Green/plain dot in agent picker.
- Stale-round guard for startup flows.

---

### 2B. pi-subagents — `./pi-subagents`

**a) Inline compact widget (implemented)**

During foreground runs the extension drives pi's `setWorkingMessage` with a live progress
line. `ForegroundControl` tracks `currentAgent`, `currentIndex`, `currentTool`, `currentPath`,
`turnCount`, `toolCount`, `tokens`.
([`src/tui/fleet.ts:21`](https://github.com/nicobailon/pi-subagents/blob/e658b40fe72d599df231b5d59ffec40d66f576fa/src/tui/fleet.ts#L21))

**b) Fleet inspector TUI — `SubagentFleetComponent` (implemented)**

([`src/tui/fleet.ts:243`](https://github.com/nicobailon/pi-subagents/blob/e658b40fe72d599df231b5d59ffec40d66f576fa/src/tui/fleet.ts#L243-L278))

- Left pane: list of foreground-active, foreground-recent, and async items.
- Right pane: detail lines (run id, state, mode, child index, started, current tool,
  turns, tokens, transcript tail).
- Polls every 750 ms; preserves selection by key across refreshes.
- `↑/↓` or `j/k` select; `PgUp/PgDn` scroll detail; `r` force-refresh; `Esc` close.

`collectFleetSnapshot`
([`fleet.ts:78`](https://github.com/nicobailon/pi-subagents/blob/e658b40fe72d599df231b5d59ffec40d66f576fa/src/tui/fleet.ts#L78-L147))
merges live foreground controls + async job summaries into a flat `FleetItem[]`.

**c) Status glyphs (implemented)**

([`fleet.ts:149`](https://github.com/nicobailon/pi-subagents/blob/e658b40fe72d599df231b5d59ffec40d66f576fa/src/tui/fleet.ts#L149-L155))

| State | Glyph | Color |
|---|---|---|
| running | `●` | accent |
| queued / pending | `◦` | muted |
| complete / completed | `✓` | success |
| paused / stopped / detached | `■` | warning |
| everything else | `✗` | error |

**d) Detail modes per item kind (implemented)**

([`fleet.ts:157`](https://github.com/nicobailon/pi-subagents/blob/e658b40fe72d599df231b5d59ffec40d66f576fa/src/tui/fleet.ts#L157-L229))

- `foreground-active`: live tool, turns, tokens, transcript note.
- `foreground-recent`: output path, session file, transcript tail.
- `async`: output path, session, full async transcript.

**e) Completion batcher (implemented)**

`CompletionBatcher` groups successful completions within a debounce window; failures and
attention signals bypass grouping and fire immediately.
([`src/shared/types.ts:173`](https://github.com/nicobailon/pi-subagents/blob/e658b40fe72d599df231b5d59ffec40d66f576fa/src/shared/types.ts#L173-L185))

**f) "Needs attention" control notices (implemented)**

`ControlEvent`
([`src/shared/types.ts:193`](https://github.com/nicobailon/pi-subagents/blob/e658b40fe72d599df231b5d59ffec40d66f576fa/src/shared/types.ts#L193-L213))
carries `type: "needs_attention" | "active_long_running"`.
`handleSubagentControlNotice`
([`src/extension/control-notices.ts:67`](https://github.com/nicobailon/pi-subagents/blob/e658b40fe72d599df231b5d59ffec40d66f576fa/src/extension/control-notices.ts#L67-L100))
debounces foreground notices (only fires when still actionable) and sends async notices
immediately.

**g) Steer lifecycle (implemented)**

`SteeringStatus` / `SteeringRequestStatus` / `SteeringTargetStatus` track:
`scheduled → routed → delivered | late | failed | recovered`.
([`src/shared/types.ts:219`](https://github.com/nicobailon/pi-subagents/blob/e658b40fe72d599df231b5d59ffec40d66f576fa/src/shared/types.ts#L219-L250))

**Reusable patterns (TypeScript, MIT-patterned):**
- Fleet-snapshot shape: `{ key, kind, runId, agent, state, updatedAt, … }`.
- Two-pane layout: scrollable list left + detail right, 750 ms poll.
- Detail mode dispatch: active / recent-foreground / async.
- Status glyph set: `●/◦/✓/■/✗` + theme color.
- Completion batcher: debounce + straggler window.
- Control notice delivery: foreground debounce guard.

---

### 2C. pi-interactive-subagents — `./pi-interactive-subagents`

**a) File-based activity state machine (implemented)**

`SubagentActivityState`
([`pi-extension/subagents/activity.ts:27`](https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/activity.ts#L27-L48)):

```
version: 1, runningChildId, phase: starting|active|waiting|done,
agentActive, turnActive, providerActive, toolActive,
activeScope, activeSince, waitingSince, turnIndex,
toolCallId, toolName, toolStartedAt, toolEndedAt
```

File-based, written atomically, throttled at 500 ms.
Recorder interface: `sessionStart`, `turnStart`, `toolExecutionStart`, `toolCall`,
`toolResult`, `toolExecutionEnd`, `agentEndWaiting`, `agentEndDone`, `sessionShutdown`.
([`activity.ts:56`](https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/activity.ts#L56-L76))

**b) Status observation model (implemented)**

`StatusObservation`
([`pi-extension/subagents/status.ts:25`](https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/status.ts#L25-L42))
reads the activity file and maps into `kind: starting|active|waiting|stalled|running`.
`SNAPSHOT_STALLED_AFTER_MS = 60_000` classifies silence beyond 60 s as stalled.
`SubagentStatusState` carries `currentKind`, `snapshotState`, `snapshotProblemSinceMs`.
([`status.ts:43`](https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/status.ts#L43-L78))

**Reusable:** Stale threshold (60 s) prevents false "active" after child death. The
`snapshotProblemSinceMs` pattern — tracking how long the snapshot has been absent/invalid —
applies directly to OO's `lost` state detection.

---

### 2D. onurpi / turn-fold + live-stats — `./onurpi`

**a) Compact / expanded turn transcript (implemented)**

`TurnFoldMode: "compact" | "expanded"`
([`packages/turn-fold/mode.ts:1`](https://github.com/osolmaz/onurpi/blob/1f056a3f2632404929231a5baeec968139e705c1/packages/turn-fold/mode.ts#L1-L11)).
`FoldDisplay: hidden | original | settled-final | settled-summary | settled-summary-final | streaming-summary`
([`packages/turn-fold/fold-policy.ts:3`](https://github.com/osolmaz/onurpi/blob/1f056a3f2632404929231a5baeec968139e705c1/packages/turn-fold/fold-policy.ts#L3-L9)).

**b) Streaming and settled summaries (implemented)**

While a turn has more than 3 activity rows, all older activity collapses:

```
▶ 7 earlier activities · 8 tools · 9 msgs       ← streaming
▶ Worked for 14s · 8 tools · 9 msgs             ← settled
```

`formatStreamingSummary` / `formatSettledSummary`
([`render-patches.ts:41`](https://github.com/osolmaz/onurpi/blob/1f056a3f2632404929231a5baeec968139e705c1/packages/turn-fold/render-patches.ts#L41-L57)).
`FoldSummary` carries: `aborted`, `compactions`, `durationMs`, `failedTools`,
`hiddenActivities`, `messages`, `running`, `tools`.
([`turn-state.ts:42`](https://github.com/osolmaz/onurpi/blob/1f056a3f2632404929231a5baeec968139e705c1/packages/turn-fold/turn-state.ts#L42-L52))

**c) Live stats line (implemented)**

`LiveStatsTracker`
([`packages/live-stats/live-stats.ts:39`](https://github.com/osolmaz/onurpi/blob/1f056a3f2632404929231a5baeec968139e705c1/packages/live-stats/live-stats.ts#L39-L65))
tracks elapsed, output tokens (exact after turn; estimated mid-turn at 4 chars/token with
`~` prefix), tokens/s in a 5 s sliding window.

```
⠋ Yardırıyorum… (12s · ~438 out · 21.7 tok/s)
```

**Reusable:** `LiveStatsTracker` is zero-dependency TS. `formatStreamingSummary` /
`formatSettledSummary` are self-contained with no Pi runtime dependency. Both are direct
design donors for OO's compact delegated-run row.

---

### 2E. OpenClaw control-plane — `./openclaw`

**a) Session status reconciliation (implemented)**

`runManagerGetSessionStatus`
([`src/acp/control-plane/manager.status.ts:21`](https://github.com/openclaw/openclaw/blob/372b527da4a1cee5b819e7852f6e26ef11160e85/src/acp/control-plane/manager.status.ts#L21-L80))
reads a live ACP runtime status and reconciles persisted identity metadata. Pattern:
read durable meta → ensure handle → call `runtime.getStatus` → reconcile identifiers →
return unified `AcpSessionStatus`. This is the same subscribe → refetch → reconcile
pattern OO's live client needs.

**b) Active-turns liveness (borrowed)**

Already in OO via `active-turns.ts`
([`src/acp/control-plane/active-turns.ts`](https://github.com/openclaw/openclaw/blob/372b527da4a1cee5b819e7852f6e26ef11160e85/src/acp/control-plane/active-turns.ts)):
in-process active-turn set + durable rows for liveness, never persisted metadata alone.

---

## 3. Candidate matrix

| Dimension | Codex TUI | pi-subagents | pi-interactive-subagents | onurpi | OO today |
|---|---|---|---|---|---|
| Inline live status row | ✓ | ✓ `setWorkingMessage` | ✓ phase labels | ✓ shimmer + stats | ✗ dead snapshot |
| Hide tool args / noise | ✓ | ✓ working line | ✓ tool name only | ✓ fold collapses | ✗ raw JSON |
| Compact fold / summary | ✓ 3-line preview | ✓ fleet detail | ✗ | ✓ `▶ Worked for…` | ✗ |
| Fleet inspector / picker | ✓ Alt+←/→ | ✓ full TUI | ✗ | ✗ | ✗ |
| Completion surfacing | ✓ history cell | ✓ CompletionBatcher | ✓ phase=done | ✓ settled-summary | ✗ |
| Stalled / failure | ✓ McpStartupStatus | ✓ needs_attention | ✓ stalled-60s | ✓ aborted | ✗ |
| Cancel / steer | ✓ Esc | ✓ /subagents-stop | ✗ | ✗ | tool-call only |
| Resume | ✓ ResumeAgent | ✓ action=resume | ✗ | ✗ | ✓ manage_agent_run |
| State across restarts | ✓ restore_running | ✓ versioned artifact | ✓ file snapshot | ✓ mode in session | ✓ daemon reconciles |
| Nonblocking parent | ✓ TurnLifecycleState | ✓ background queue | — | — | ✓ delegate returns |
| ACP startup failure | ✓ (MCP-specific) | ✓ control notice | ✓ stalled kind | ✗ | ✗ |

---

## 4. Recommendation — cheapest credible adoption path

### Step 1 — Live inline update (smallest, immediate value)

Extend `ooPresentationExtension` to subscribe to `agent-run.changed` SSE after
`delegate_agent` or `manage_agent_run` closes. On each invalidation, refetch
`/agent-runs/:id` and call `ctx.ui.setWorkingMessage` with a refreshed
`formatAgentRunRow`. One line, one seam, no new component. Pattern: onurpi
`LiveStatsTracker` elapsed tracking + OO's existing `GatewayApi.subscribe`.

```
Owner Operator v0.0.1
> Delegate a review to Claude Code
  delegating to an agent…
  ↳ claude-code · review auth PR · running · reading…    ← SSE-driven, replaces on each event
  ↳ claude-code · review auth PR · completed · LGTM  3m 12s   ← final snapshot, then clears
```

### Step 2 — Compact tool result fold

Replace the current raw-JSON `renderResult` for `delegate_agent` / `manage_agent_run`
with a `formatAgentRunRow`-driven cell. Collapsed by default; expand with pi's existing
tool-expand key. Pattern: existing `ooRenderResult` in `src/shared/oo-presentation.ts:354`.

```
› Delegate agent  claude-code · review auth PR
✓ claude-code · review auth PR · completed · 3m 12s
  [↵ expand]

— expanded —
› Delegate agent  claude-code · review auth PR
✓ claude-code · review auth PR · completed · 3m 12s
  LGTM, only minor nits on the token refresh path.
  run id: agt_01HX…
```

### Step 3 — Completion notification on the working line

After a background run finishes (SSE `agent-run.changed` + terminal status), fire
`ctx.ui.setWorkingMessage` with the settled row for one cycle before clearing. Pattern:
onurpi `formatSettledSummary` / pi-subagents `CompletionBatcher`.

```
claude-code · review auth PR · completed · LGTM  3m 12s   ← fires once, then clears
```

### Step 4 — Startup failure surfacing

Map ACP child process non-zero exit at spawn time → run `error` field → surface on the
working line rather than waiting for `manage_agent_run status`. Pattern:
`McpStartupStatus.Failed { error }` from Codex TUI — same stale-round guard prevents
a restart from re-surfacing a resolved startup error.

```
claude-code · review auth PR · failed · ACP handshake timeout
```

### Step 5 — `/runs` fleet command (later)

`collectFleetSnapshot` (pi-subagents MIT-patterned) shows the cheapest path to a live
two-pane inspector. In OO's context: Gateway SSE subscriber → refetch `/agent-runs` →
render sorted list with glyph + detail pane on selection. Gate on a slash command first
(`/runs`) before adding a persistent widget panel.

```
/runs

  ● claude-code · review auth PR · 3m 12s
  ✓ codex · scaffold tests · 14m 08s
  ✗ claude-code · fix lint · timed out

[↑/↓ select  Esc close  r refresh  c cancel]

Detail ─────────────────────────────────────────
Run:     agt_01HX…
State:   running
Task:    review auth PR
Harness: claude-code
Elapsed: 3m 12s
Activity: reading session state…
```

---

## 5. What NOT to adopt

- **onurpi `render-patches.ts`**: patches Pi's internal `ToolExecutionComponent` via
  `Reflect.get`. OO's `withOoRenderers` is cleaner.
- **pi-subagents full foreground execution**: 80+ imports, acceptance ledger, watchdog,
  tool budget. Overkill for OO's single durable row.
- **Codex `CollabAgentTool` / v2 protocol**: Codex's collab agents are a v2 protocol
  concern. OO's `agent_runs` ledger is the right authority; don't adopt Codex's in-process
  thread model.
- **pi-interactive-subagents file-based snapshot directly**: OO already has SSE + Gateway
  ledger rows — a richer seam with less polling.
- **pi-subagents `SubagentFleetComponent` directly**: depends on `@earendil-works/pi-tui`
  component primitives that OO's `InteractiveMode` doesn't expose.

---

## 6. Key source locations

| Pattern | Source | Pinned path |
|---|---|---|
| `StatusIndicatorWidget` — animated row | Codex | [`codex-rs/tui/src/status_indicator_widget.rs:46`](https://github.com/openai/codex/blob/0b175e6439a8608ba7726ee153fd8590619e8f34/codex-rs/tui/src/status_indicator_widget.rs#L46-L61) |
| `AgentStatusHistoryCell` — 3-line preview | Codex | [`tui/src/app/agent_status_feed.rs:22`](https://github.com/openai/codex/blob/0b175e6439a8608ba7726ee153fd8590619e8f34/codex-rs/tui/src/app/agent_status_feed.rs#L22-L62) |
| `activity_summary` — tool-call label taxonomy | Codex | [`tui/src/app/agent_status_feed.rs:135`](https://github.com/openai/codex/blob/0b175e6439a8608ba7726ee153fd8590619e8f34/codex-rs/tui/src/app/agent_status_feed.rs#L135-L197) |
| Agent picker dot + `Alt+←/→` | Codex | [`tui/src/multi_agents.rs:75`](https://github.com/openai/codex/blob/0b175e6439a8608ba7726ee153fd8590619e8f34/codex-rs/tui/src/multi_agents.rs#L75-L82) |
| `McpStartupStatus` — startup failure | Codex | [`tui/src/chatwidget/mcp_startup.rs:18`](https://github.com/openai/codex/blob/0b175e6439a8608ba7726ee153fd8590619e8f34/codex-rs/tui/src/chatwidget/mcp_startup.rs#L18-L23) |
| `SubagentFleetComponent` — full fleet TUI | pi-subagents | [`src/tui/fleet.ts:243`](https://github.com/nicobailon/pi-subagents/blob/e658b40fe72d599df231b5d59ffec40d66f576fa/src/tui/fleet.ts#L243-L278) |
| `collectFleetSnapshot` — snapshot shape | pi-subagents | [`src/tui/fleet.ts:78`](https://github.com/nicobailon/pi-subagents/blob/e658b40fe72d599df231b5d59ffec40d66f576fa/src/tui/fleet.ts#L78-L147) |
| `statusGlyph` — ●/◦/✓/■/✗ | pi-subagents | [`src/tui/fleet.ts:149`](https://github.com/nicobailon/pi-subagents/blob/e658b40fe72d599df231b5d59ffec40d66f576fa/src/tui/fleet.ts#L149-L155) |
| `CompletionBatcher` — debounced notify | pi-subagents | [`src/shared/types.ts:173`](https://github.com/nicobailon/pi-subagents/blob/e658b40fe72d599df231b5d59ffec40d66f576fa/src/shared/types.ts#L173-L185) |
| `ControlEvent` + "needs attention" | pi-subagents | [`src/shared/types.ts:193`](https://github.com/nicobailon/pi-subagents/blob/e658b40fe72d599df231b5d59ffec40d66f576fa/src/shared/types.ts#L193-L213) |
| `SubagentActivityState` — file-based phases | pi-interactive-subagents | [`pi-extension/subagents/activity.ts:27`](https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/activity.ts#L27-L48) |
| `StatusObservation` + stalled-after-60s | pi-interactive-subagents | [`pi-extension/subagents/status.ts:25`](https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/status.ts#L25-L42) |
| `FoldDisplay` + `formatStreamingSummary` | onurpi | [`packages/turn-fold/fold-policy.ts:3`](https://github.com/osolmaz/onurpi/blob/1f056a3f2632404929231a5baeec968139e705c1/packages/turn-fold/fold-policy.ts#L3-L9); [`render-patches.ts:41`](https://github.com/osolmaz/onurpi/blob/1f056a3f2632404929231a5baeec968139e705c1/packages/turn-fold/render-patches.ts#L41-L57) |
| `LiveStatsTracker` — elapsed + tok/s | onurpi | [`packages/live-stats/live-stats.ts:39`](https://github.com/osolmaz/onurpi/blob/1f056a3f2632404929231a5baeec968139e705c1/packages/live-stats/live-stats.ts#L39-L65) |
| ACP session status reconciliation | OpenClaw | [`src/acp/control-plane/manager.status.ts:21`](https://github.com/openclaw/openclaw/blob/372b527da4a1cee5b819e7852f6e26ef11160e85/src/acp/control-plane/manager.status.ts#L21-L80) |
| OO live status line (current) | OO | `src/shared/oo-presentation.ts:260` |
| OO `formatAgentRunRow` (current) | OO | `src/shared/oo-presentation.ts:229` |
| OO delegate tool (current) | OO | `src/agent/tools/delegate-agent.ts:17` |
| OO live-state gaps (authoritative) | OO | `docs/delegated-runs.md#live-state-and-clients` |
