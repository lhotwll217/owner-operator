---
title: "Delegated agents and TUIs — what is actually possible"
summary: "What OO's ACP delegation path can and cannot do today: harnesses, resume, child identity, and whether a child's work can be opened or spectated in a TUI"
read_when:
  - Deciding whether an "open delegated run in its native TUI" feature is feasible
  - Understanding what the OO TUI shows about delegated runs vs. the child's transcript
  - Checking ACP / acpx / codex-acp / harness-resume facts before designing spectate features
---

# Delegated agents and TUIs — what is actually possible (2026-08-05)

Research snapshot at repo `403cfc11584519bded5ba22833278d4b9689efc3`, installed deps
`acpx@0.11.2` and `@agentclientprotocol/codex-acp@1.1.5` (`package.json`). Code cites are
`path:line`; npm-dist cites are `package@version` file paths.

## 1. Delegation over ACP works today

- Two harnesses, both resumable: `AGENT_RUN_CAPABILITIES` in
  `packages/core/src/agent-runs.ts:67-84` declares `claude-code` (acpAgent `claude`) and
  `codex`, each with `activitySource: "acp-events"`, `resume: true`, and
  `steerMidRun: false`, `asksToParent: false`.
- Path: `delegate_agent` → Gateway `/agent-runs` → `AgentRunExecutor.launch`
  (`src/agent-runs/executor.ts:127-160`, durable `pending` row, background by default,
  concurrency cap, depth cap 1) → ACP launcher (`src/agent-runs/acp-launcher.ts:50-121`)
  which builds an `acpx/runtime` (`createAcpRuntime`, session store, agent registry),
  `ensureSession` + `startTurn`, mirrors ACP `text_delta`/`status`/`tool_call` events into
  ledger activity (`acp-launcher.ts:147-166`), and maps the protocol turn result — never
  bare process exit — to `completed | cancelled | failed` (`acp-launcher.ts:168-181`).
- Adapters: Claude goes through acpx's registry entry
  `npx -y @agentclientprotocol/claude-agent-acp` (`acpx@0.11.2
  dist/live-checkpoint-mdAaF3qJ.js:442,467-471`). Codex bypasses acpx's stale pinned
  registry and runs OO's direct dependency `@agentclientprotocol/codex-acp`
  (`src/agent-runs/acp-launcher.ts:218-224`).
- Resume: `executor.resume` (`src/agent-runs/executor.ts:196-229`) requires a resumable
  status (`interrupted|lost|failed`, `packages/core/src/agent-runs.ts:48-52`), the harness
  capability, and a persisted `childSessionId`; it creates a *new* run under the same child
  identity and passes `resumeSessionId` to `ensureSession`
  (`src/agent-runs/acp-launcher.ts:208-215`). The live acceptance
  (`src/agent-runs/acp-launcher.live.test.ts:143-158`) SIGKILLs the daemon mid-turn and
  verifies interrupted → resume with the same `childSessionId` against real Claude.

## 2. Opening a child's work in a TUI afterward

### The ACP protocol has no attach/spectate concept

The spec's Session Setup page (https://agentclientprotocol.com/protocol/session-setup)
defines `session/new` ("The Agent MUST respond with a unique Session ID"), `session/load`
("The Agent MUST replay the entire conversation to the Client in the form of
`session/update` notifications" — sections "Loading Sessions"), and `session/resume`
("the Agent MUST NOT replay the conversation history" — "Resuming Sessions"). There is no
notion of a second client attaching to or spectating a live session; sessions are
single-client, reloaded/resumed sequentially. acpx mirrors exactly this surface
(`supportsLoadSession`/`supportsResumeSession`, `acpx@0.11.2
dist/client-DIlpCkHw.d.ts:118-124`); it adds no attach primitive either.

### `childSessionId` is the harness-native session id

- acpx captures `agentSessionId` from the adapter's `session/new` / `session/resume`
  response `_meta` (keys `agentSessionId`/`sessionId`, `acpx@0.11.2
  dist/live-checkpoint-mdAaF3qJ.js:935-951,3745`) alongside `backendSessionId` (the ACP
  `sessionId`). OO's launcher prefers `agentSessionId`, falling back to
  `backendSessionId` "when an adapter (currently Claude) exposes no separate native id"
  (`src/agent-runs/acp-launcher.ts:246-259`).
- **Codex:** codex-acp's `newSession` returns `sessionId: response.thread.id` from Codex's
  own `thread/start` app-server call (`@agentclientprotocol/codex-acp@1.1.5
  dist/index.js:26073-26095`), so the ACP session id *is* the native Codex thread id.
  `codex resume <id>` accepts it: "Resume the specified session. Omit and use `--last`"
  (https://learn.chatgpt.com/docs/developer-commands?surface=cli). Codex resume continues
  the same transcript; forking is a separate explicit operation.
- **Claude:** claude-agent-acp wraps the Claude Agent SDK; SDK sessions persist as
  `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`, the same id `claude --resume`
  takes (https://github.com/agentclientprotocol/claude-agent-acp;
  https://deepwiki.com/zed-industries/claude-code-acp/4.3-session-lifecycle-management).
  `claude --resume <id>` continues the *same* session id; `--fork-session` mints a new one
  (https://code.claude.com/docs/en/cli-reference).
- OO's own monitor corroborates the native-id claim: session-state rows join to run rows
  by `agent_runs.child_session_id == observed transcript thread id` — an identity join
  over the harness's ordinary transcript files (`src/state/schema-docs.ts:117`,
  `src/state/delegated-run-join.integration.test.ts:3`, docs/delegated-runs.md
  "Tracking boundary"). That only works because `childSessionId` is the native id.

### OO persists everything an "open in native TUI" feature needs

`agent_runs.child_session_id` and `acpx_record_id` are durable columns
(`src/state/database.ts:182-194`); acpx session records and process leases live under
`~/.owner-operator/agent-runs/` (`src/agent-runs/acp-launcher.ts:33-38`,
docs/delegated-runs.md "State") precisely so identities survive daemon restarts. So
`claude --resume <child_session_id>` (cwd-scoped) or `codex resume <child_session_id>`
after a run finishes is feasible today with data OO already has. Caveats: it is a
*resume*, not a spectate — the native TUI becomes a second writer to the same session, so
it should only be offered for terminal runs (OO's own resume guard already refuses
concurrent turns on one child, `src/agent-runs/executor.ts:209-214`); and Claude resume is
picker/project-scoped by cwd, so the launch must use the run's recorded `cwd`.

## 3. What OO's own TUI shows today

- `./oo` interactive registers `agentStateExtension`
  (`src/cli/interactive.ts:74`). It renders a footer count and the `/agent-state` picker:
  per-run rows with status glyph, task, harness/model/effort, elapsed; "inspect" (enter)
  shows only Task, Harness, Effort, Status, Elapsed, and the latest bounded activity line
  (`src/agent-runs/agent-state-extension.ts:91-107`). Controls are cancel and resume only
  (`agent-state-extension.ts:74-78`).
- Activity is a single replaced 200-char preview, "latest activity, not a durable event
  log" (docs/delegated-runs.md "Live state and clients";
  `src/agent-runs/acp-launcher.ts:261-264`); results are a bounded `result_tail` (32KB
  persisted). Completion arrives in the parent thread via `ParentRunSession` + the Pi
  custom-message adapter (`src/agent-runs/parent-run-session.ts`,
  `src/agent-runs/agent-run-completion.ts`).
- **No transcript view.** Neither the picker nor the widget renders the child's
  conversation; the widget shows the child at most as an ordinary session row once the
  monitor admits its transcript (docs/widget.md; docs/delegated-runs.md "Lineage and
  presentation").

## 4. Not possible today (grounded)

- **Live spectating of an in-flight ACP child, in any TUI.** ACP has no attach/observe
  method (spec, above); acpx exposes one client per session; OO's daemon *is* that client
  and holds the stdio pipe. A second `claude`/`codex` TUI on the same session id while the
  turn runs would be a concurrent writer, which nothing in either CLI's docs supports and
  OO's executor explicitly guards against for its own resumes
  (`src/agent-runs/executor.ts:209-214`).
- **Viewing the child's transcript inside OO.** No client renders it; only the activity
  preview and result tail exist in the ledger (§3). A read-only replay *is* protocol-
  feasible later via `session/load` (spec "Loading Sessions") or by reading the harness
  transcript file the monitor already discovers — but no such surface exists.
- **Mid-run steering / asks-to-parent:** capability records set `steerMidRun: false`,
  `asksToParent: false` for both harnesses (`packages/core/src/agent-runs.ts:72-82`);
  permission asks are auto-approved into the child harness's own config
  (`src/agent-runs/acp-launcher.ts:84-88`).
- **Remote access:** the Gateway binds only `127.0.0.1` with a mode-0600 bearer-token
  discovery file (docs/daemon.md:15).
- **Non-macOS:** OO is macOS-only overall (README.md:3); the widget and always-on
  services are macOS (docs/widget.md:3, docs/onboarding.md:17). The delegation core is
  plain Node + acpx, but nothing else is tested or supported elsewhere.
- **Depth > 1 delegation:** rejected by the executor and forbidden in every child prompt
  (`src/agent-runs/executor.ts:143-147`, `src/agent-runs/acp-launcher.ts:25-31`).

Sources: https://agentclientprotocol.com/protocol/session-setup ·
https://code.claude.com/docs/en/cli-reference ·
https://learn.chatgpt.com/docs/developer-commands?surface=cli ·
https://github.com/agentclientprotocol/claude-agent-acp ·
https://deepwiki.com/zed-industries/claude-code-acp/4.3-session-lifecycle-management
