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
| [`harness/`](harness/) | **"PI"** — agentic core built on the [pi coding agent](https://github.com/earendil-works/pi) (consumed via npm: `@earendil-works/pi-*`). `oo` CLI + branded TUI, structured triage over local session files via our own scan/grep skills. | 🧩 read/triage live |
| [`apps/widget/`](apps/widget/) | macOS native widget — always-there glanceable triage. | 📐 planned |
| [`apps/web/`](apps/web/) | localhost web UI — drill into sessions, read-first. | 📐 planned |
| [`packages/core/`](packages/core/) | Shared, UI-independent types the surfaces + harness agree on — `Thread`/`Triage` + `sortByPriority`. | 🧩 threads contract |
| [`packages/workflows/`](packages/workflows/) | Deterministic workflow scripts. | 📐 planned |
| [`scripts/`](scripts/) | Repo tooling / dev scripts. | 📐 planned |
| [`docs/`](docs/) | Architecture & design notes. | ✍️ in progress |

## Data source

V1 reads CLI agent sessions **directly off disk** with our own dependency-free scan/grep
skills ([`.agents/skills`](.agents/skills/)) — `get-active-threads`, `sessions-grep`,
`session-keywords`. Today that covers **Claude Code** (`~/.claude/projects`) and **Codex**
(`~/.codex/sessions`); more sources slot in as skills. Scanning the files directly — never
loading full transcripts into a model — is the "look across everything" layer the operator
triages on top of.

## Status

🌱 **Early, but real.** The read/triage layer works end to end: a plain `oo` CLI (REPL +
one-shot, plus a `--json` headless snapshot) and a branded TUI, both on the **pi coding
agent** (npm deps, openclaw-style — not a fork). The agent reads local session files
(Claude Code + Codex) with our own scan/grep skills, triages them into a structured
`Thread[]` ([`packages/core`](packages/core/)), and each surface renders that one payload
(cards / JSON). Next: the web + widget surfaces, scheduled briefs, and richer triage.
