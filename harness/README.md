# harness — "PI"

The agentic core of Owner Operator, built on the open-source
**[pi coding agent](https://github.com/earendil-works/pi)** toolkit.

**We consume pi as npm dependencies — not a fork, not a submodule.** pi is published as
libraries (`@earendil-works/pi-*`, MIT), so we depend on the pieces we need and build the
Owner Operator layer on top. This is exactly how [openclaw](https://github.com/openclaw/openclaw)
(the largest pi-based product) does it: its own repo, pi pulled in via npm.

Current deps (see [`package.json`](package.json)):

- `@earendil-works/pi-agent-core` — the agent framework we build the harness on.
- `@earendil-works/pi-ai` — unified LLM API for the triage/summarize calls.

Also available from the same toolkit when we need them: `@earendil-works/pi-tui`
(terminal UI) and `@earendil-works/pi-coding-agent` (the full `pi` CLI). Pinned exact
(`0.78.0`) because pi is pre-1.0 and ships fast.

## Ecosystem we can lean on

- [`BlackBeltTechnology/pi-agent-dashboard`](https://github.com/BlackBeltTechnology/pi-agent-dashboard)
  — prior art for the web UI: multi-session view, live mirroring, diff viewer, mobile
  remote control.
- [`badlogic/pi-diff-review`](https://github.com/badlogic/pi-diff-review) — relevant to
  the V3 inline-diff-review goal.

## What we build here (the Owner Operator layer)

- Read across all CLI agent sessions via the **`ai-sessions` MCP** (Claude Code, Codex,
  Gemini CLI, opencode, …).
- Compute triage/priority over active threads; produce concise briefs on a schedule
  ("monitor the situation").
- Expose a **bounded, enumerated command set** — pi extensions/skills constrained to
  read + triage. It reads and organizes; it does **not** drive sub-agents or author work
  in branches.

See [../VISION.md](../VISION.md) and [../docs/architecture.md](../docs/architecture.md).
