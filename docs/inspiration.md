# Inspiration — TUI & multi-agent tools

Reference list of prior art for Owner Operator's surfaces and the multi-agent
problem space. Sister doc to [VISION.md](../VISION.md) and
[architecture.md](./architecture.md).

## Building on pi (our stack)

The ecosystem we build on. For how we develop & run on top of it — dev mode vs.
local install — see [development.md](./development.md).

- **[pi](https://github.com/earendil-works/pi)** (`@earendil-works/pi-*`) — the toolkit we build on.
- **[OpenClaw](https://github.com/openclaw/openclaw)** — the largest pi-based product (own repo, pi via npm).
- **[Hermes Agent](https://github.com/NousResearch/hermes-agent)** — local-first CLI agent in the same ecosystem.

## The list

- **[rothgar/awesome-tuis](https://github.com/rothgar/awesome-tuis)** — community
  catalog of TUI applications. Good for crowd sourcing approaches and examples of UX / UI withing the terminal
  
  We should update projects and list out specific features we can use from each project i.e. agent-deck and session status polling

## Multi-agent tools (from awesome-tuis)

Tools that manage, observe, or coordinate **more than one** AI coding agent — the
closest neighbors to what Owner Operator does.

- **[amux](https://github.com/andyrewlee/amux)** — easily run parallel coding agents.
- **[agent-deck](https://github.com/asheshgoplani/agent-deck)** — terminal dashboard
  for managing multiple AI coding agent sessions.
    - Polling for agent status
- **[Claude Code Bridge](https://github.com/bfly123/claude_code_bridge)** — real-time
  multi-AI collaboration between Claude, Codex and Gemini in terminal.
- **[Quorum](https://github.com/Detrol/quorum-cli)** — multi-agent AI discussion
  system for structured debates between LLMs.
- **[kagan](https://github.com/kagan-sh/kagan)** — AI-powered Kanban TUI for
  autonomous development workflows.
- **[Backlog.md](https://github.com/MrLesk/Backlog.md)** — managing project
  collaboration between humans and AI agents in a git ecosystem.
- **[fast-resume](https://github.com/angristan/fast-resume)** — index and fuzzy
  search coding agent sessions.
- **[Cloud Code Usage Monitor](https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor)**
  — monitor Claude token usage.
- **[models](https://github.com/arimxyer/models)** — TUI for browsing AI models and
  coding agents.

## Single-agent coding TUIs (the branches we sit above)

Useful as context — these are the kind of session Owner Operator reads from, not
competes with.

- **[codex](https://github.com/openai/codex)** — OpenAI's lightweight coding agent
  in the terminal.
- **[crush](https://github.com/charmbracelet/crush)** — Charm's AI coding agent.
- **[opencode](https://github.com/sst/opencode)** — AI coding agent, built for the
  terminal.
- **[VT Code](https://github.com/vinhnx/vtcode)** — semantic coding agent.
- **[Toad](https://github.com/batrachianai/toad)** — a unified interface for AI.
- **[tweakcc](https://github.com/Piebald-AI/tweakcc)** — TUI to customize Claude
  Code themes, thinking verbs, and more.
