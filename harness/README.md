# harness — "PI"

Agentic core of Owner Operator, on the **[pi coding agent](https://github.com/earendil-works/pi)**
toolkit. pi is consumed as npm dependencies (`@earendil-works/pi-*`, MIT) — not a fork —
same as [openclaw](https://github.com/openclaw/openclaw).

Deps (see [`package.json`](package.json)), all pinned exact at `0.78.0` (pi is pre-1.0):

- `@earendil-works/pi-coding-agent` — the agent SDK: sessions, tools, skills, print mode.
- `@earendil-works/pi-ai` — LLM API + type system for the triage calls.
- `@earendil-works/pi-tui` — terminal-UI primitives for the branded TUI.

## What's here

- Reads local agent sessions via the scan/grep skills in [`.agents/skills`](../.agents/skills/)
  (see [supported sources](../README.md#how-it-works)) — never loading full transcripts into a model.
- Ranks the threads; `oo daemon` serves them to the UIs.

See [../docs/architecture.md](../docs/architecture.md).
