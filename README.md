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
| [`harness/`](harness/) | **"PI"** — agentic core built on the [pi coding agent](https://github.com/earendil-works/pi) (consumed via npm: `@earendil-works/pi-*`). Strict command set, scheduling, bootstraps off the `ai-sessions` MCP. | 🧩 pi wired in |
| [`apps/widget/`](apps/widget/) | macOS native widget — always-there glanceable triage. | 📐 planned |
| [`apps/web/`](apps/web/) | localhost web UI — drill into sessions, read-first. | 📐 planned |
| [`packages/core/`](packages/core/) | Shared types the surfaces + harness agree on (sessions, threads, priority). | 📐 planned |
| [`packages/workflows/`](packages/workflows/) | Deterministic workflow scripts. | 📐 planned |
| [`scripts/`](scripts/) | Repo tooling / dev scripts. | 📐 planned |
| [`docs/`](docs/) | Architecture & design notes. | ✍️ in progress |

## Data source

V1 bootstraps the cross-agent read from the **`ai-sessions` MCP**, which exposes CLI
sessions from Claude Code, Codex, Gemini CLI, opencode, Mistral Vibe, and Copilot CLI.
That's the "look across everything" layer the operator triages on top of.

## Status

🌱 **Scaffolding.** Vision, architecture notes, folder skeleton, and the **pi coding
agent wired in as npm dependencies** ([`harness/package.json`](harness/package.json),
openclaw-style — not a fork, not a submodule). No Owner Operator application code yet —
by design. Next: the read/triage layer on top of pi + the `ai-sessions` cross-section.
