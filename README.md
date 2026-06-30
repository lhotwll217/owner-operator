# Owner Operator

> A local-first **chief of staff** that sits above all your CLI agents and below your
> attention — it reads, organizes, and triages every agent session on your machine so
> you can glance, prioritize, drill in, drop a prompt, and pull back up.

📖 **Start here: [VISION.md](VISION.md)** · 🏗️ **[docs/architecture.md](docs/architecture.md)**

## The loop

```
glance  →  drill into the right thread  →  drop YOUR prompt  →  pull back up
   ▲                                                                  │
   └──────────────────────  triage / prioritize  ◄───────────────────┘
```

The operator **reads and organizes; it never ghost-writes into a branch.** When you
drill in, your input is *your* prompt to *that* session. No intermediary re-driving your
sub-agents.

## Repo layout

| Path | What | Status |
|------|------|--------|
| [`harness/`](harness/) | **"PI"** — agentic core built on the [pi coding agent](https://github.com/earendil-works/pi) (consumed via npm: `@earendil-works/pi-*`). `oo` CLI + branded TUI, structured triage over local session files via our own scan/grep skills, plus `oo daemon` — the single state-owning process (poll loop, schedules/triggers, HTTP+SSE push) the surfaces ride. | 🧩 read/triage + daemon live |
| [`apps/widget/`](apps/widget/) | macOS native widget — always-there glanceable triage. | 📐 planned |
| [`apps/web/`](apps/web/) | localhost web UI — drill into sessions, read-first. | 📐 planned |
| [`packages/core/`](packages/core/) | Shared, UI-independent types the surfaces + harness agree on — `Thread`/`Triage` + `sortByPriority`, plus the model-free `ThreadStatus` state machine and the **canonical thread-state resolver** every surface joins through (`resolveState`/`resolveCandidates`/`reconcile`/`diffSnapshots`). | 🧩 threads + status contract |
| [`packages/workflows/`](packages/workflows/) | Deterministic workflow scripts. | 📐 planned |
| [`scripts/`](scripts/) | Repo tooling / dev scripts. | 📐 planned |
| [`docs/`](docs/) | Architecture & design notes. | ✍️ in progress |

## Data source

V1 reads CLI agent sessions **directly off disk** with our own dependency-free scan/grep
skills ([`.agents/skills`](.agents/skills/)) — `get-active-threads`, `sessions-grep`,
`session-keywords`. Today that covers **Claude Code** (`~/.claude/projects`), **Codex**
(`~/.codex/sessions`), and **Cursor** (`~/.cursor/projects/*/agent-transcripts`), with
worktree hosts (**Superset**, **Conductor**) resolved as the origin app; more sources
slot in as skills. Scanning the files directly — never
loading full transcripts into a model — is the "look across everything" layer the operator
triages on top of.

## Terminal frontends

Two terminal surfaces ride the same agent core (one prompt, skills, tools, model in
[`harness/src/agent.ts`](harness/src/agent.ts)), and we're **maintaining both for now**:

- **Branded TUI** (default — `./harness/oo`) — our fixed-viewport layout with a pinned
  left **thread-sidebar** beside the chat. Hand-rolled because pi's TUI has no columns
  primitive, and **no extension can add one** — `setWidget` only stacks above/below the
  editor. The pinned sidebar is this surface's reason to exist.
- **pi interactive mode** (flagged — `./harness/oo -i` / `--interactive`, or
  `OO_INTERACTIVE=1`) — pi's **stock `InteractiveMode`**, wired to our config, so we get
  its Editor (slash-command autocomplete, input history), theming, footer, and message
  components for free. An owner-operator **extension** ([`harness/src/oo-extension.ts`](harness/src/oo-extension.ts))
  closes the gap the way pi intends: `registerMessageRenderer` renders triage as our cards
  inline, and `registerCommand` adds `/done`, `/threads`, `/help` with completion. This is
  the "lean on the shared pattern" surface — ~30 lines of registrations instead of a second
  shell.

Both are good; the branded TUI earns its keep *only* for the sidebar layout. Branches:
`main` (branded TUI) and `claude/pi-interactive-mode` (the flagged interactive surface).

## Status

🌱 **Early, but real.** The read/triage layer works end to end: a plain `oo` CLI (REPL +
one-shot, plus a `--json` headless snapshot) and a branded TUI, both on the **pi coding
agent** (npm deps, openclaw-style — not a fork). The agent reads local session files
(Claude Code + Codex) with our own scan/grep skills, triages them into a structured
`Thread[]` ([`packages/core`](packages/core/)), and each surface renders that one payload
(cards / JSON). Next: the web + widget surfaces, scheduled briefs, and richer triage.
