# Inspiration Dock

Tools we can learn from. Sister doc to [VISION.md](../VISION.md) and [architecture.md](./architecture.md).

**Telegraph style:** list it · link it · what it is · what to borrow.

## Building on pi (our stack)

- **[pi](https://github.com/earendil-works/pi)** (`@earendil-works/pi-*`) — the toolkit we build on.
- **[OpenClaw](https://github.com/openclaw/openclaw)** — largest pi-based product (own repo, pi via npm).
- **[Hermes Agent](https://github.com/NousResearch/hermes-agent)** — local-first CLI agent, same ecosystem.

## Catalogs

- **[rothgar/awesome-tuis](https://github.com/rothgar/awesome-tuis)** — community catalog of TUI apps. *Borrow:* source for UX/UI ideas and more entries in this dock.

## Multi-agent tools

- **[amux](https://github.com/andyrewlee/amux)** — run parallel coding agents. *Borrow:* parallel-agent UX.
- **[agent-deck](https://github.com/asheshgoplani/agent-deck)** — TUI session manager for AI coding agents. *Borrow:* status state machine (`● working · ◐ needs-you · ○ idle · ✕ error`); persistent session deck = our sidebar; status in tmux bar; reads transcripts per turn.
- **[Superset](https://github.com/superset-sh/superset)** — desktop IDE running an army of parallel agents in isolated worktrees. *Borrow:* monitor-and-notify "needs attention" state; persisted session state in a DB (the persisted-poll store).
- **[Claude Code Bridge](https://github.com/bfly123/claude_code_bridge)** — real-time Claude/Codex/Gemini collaboration in terminal. *Borrow:* cross-agent bridging.
- **[Quorum](https://github.com/Detrol/quorum-cli)** — multi-agent debate between LLMs. *Borrow:* structured multi-agent turns.
- **[kagan](https://github.com/kagan-sh/kagan)** — AI Kanban TUI for autonomous dev. *Borrow:* board/column triage layout.
- **[Backlog.md](https://github.com/MrLesk/Backlog.md)** — human/AI collaboration in a git repo. *Borrow:* git-native task tracking.
- **[fast-resume](https://github.com/angristan/fast-resume)** — index + fuzzy-search coding agent sessions. *Borrow:* fast cross-session search/index — the lookup layer for drilling into a thread.
- **[Cloud Code Usage Monitor](https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor)** — monitor Claude token usage. *Borrow:* token/cost surfacing.
- **[models](https://github.com/arimxyer/models)** — TUI for browsing AI models/agents. *Borrow:* model/agent picker UX.

## Session discovery & parsing (prior art)

How others find/parse local agent session files — borrowed for `get-active-threads` instead of hand-rolling.

- **ai-sessions** (connected MCP) — reads sessions across claude/gemini/codex/opencode/mistral/copilot. *Borrow:* cross-agent discovery oracle; metadata-only `list_sessions` (no transcripts) is cheap enough to back the digest.
- **[divmgl/clancey](https://github.com/divmgl/clancey)** — Claude Code JSONL parser (MIT). *Borrow:* skip `isMeta` turns; content-block extraction (text / tool_use).
- **[constellos/claude-code](https://github.com/constellos/claude-code)** — CC transcript utils (MIT). *Borrow:* same `isMeta` filtering.
- **[AgentWrapper/agent-orchestrator](https://github.com/AgentWrapper/agent-orchestrator)** — agent session classifier (MIT). *Borrow:* worker-vs-interactive by **launch mode** (`codex exec` / `claude -p --headless` / sdk), not message count.

## Single-agent coding TUIs

- **[codex](https://github.com/openai/codex)** — OpenAI's terminal coding agent.
- **[crush](https://github.com/charmbracelet/crush)** — Charm's AI coding agent.
- **[opencode](https://github.com/sst/opencode)** — terminal-built AI coding agent.
- **[VT Code](https://github.com/vinhnx/vtcode)** — semantic coding agent.
- **[Toad](https://github.com/batrachianai/toad)** — unified interface for AI.
- **[tweakcc](https://github.com/Piebald-AI/tweakcc)** — TUI to customize Claude Code themes/verbs.
