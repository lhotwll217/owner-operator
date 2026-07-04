# Inspiration

Borrow battle-tested, maintained patterns. Check here for prior art before designing
anything new; hunt beyond this list when it comes up short; cite the borrow in the issue/PR.

## Sources

- **[OpenClaw](https://github.com/openclaw/openclaw)** — [gateway daemon pattern](https://docs.openclaw.ai/gateway):
  one long-lived process owns all state, every surface a thin client. Ours:
  `harness/src/gateway/` ([architecture](architecture.md#layout--the-dependency-rule)).
  Also adopted: [oxlint](https://oxc.rs/docs/guide/usage/linter), pi as pinned npm deps,
  CI gating every PR.
- **[Hermes Agent](https://github.com/NousResearch/hermes-agent)** (Nous Research) — proven
  patterns at viral scale: skills grown from experience, persistent memory, one gateway
  process serving many chat surfaces. Pattern source for skills, memory, and surface design.
- **[opencode](https://github.com/sst/opencode)** — widely used local coding agent; a session
  source to read ([#16](https://github.com/lhotwll217/owner-operator/issues/16)) and a
  reference terminal-agent codebase.
- **[session-grep](https://github.com/lhotwll217/session-grep)** — the search primitive we
  vendor ([#20](https://github.com/lhotwll217/owner-operator/issues/20)); house vendoring
  model: wrapper owns local policy (sources, blacklist), upstream drops into `vendor/` untouched.

## pi — the toolkit we build on

[pi](https://github.com/earendil-works/pi) ships most agent plumbing (sessions, tools,
skills, extensions, modes); check its toolbox first. Tracked implementations:

| pi piece | Where it runs here |
|---|---|
| `@earendil-works/pi-coding-agent` `0.78.0` | `harness/src/agent/` — session build, tools, skills, print + RPC modes |
| `@earendil-works/pi-ai` `0.78.0` | typed model calls + `Type` schemas for the triage tools (`agent/agent.ts`) |
| `@earendil-works/pi-tui` `0.78.0` | terminal primitives under `harness/src/tui/` |
| [`pi-schedule-prompt`](https://pi.dev/packages/pi-schedule-prompt) `0.4.1` (extension) | `.pi/settings.json` `packages` — session-level scheduling ([architecture](architecture.md#schedules--triggers)) |

Open assessment: adopt pi `modes/interactive` for the TUI —
[#7](https://github.com/lhotwll217/owner-operator/issues/7).
