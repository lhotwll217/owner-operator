# Inspiration

Borrow battle-tested, maintained patterns. Check here before designing anything new; hunt
beyond this list when it comes up short; cite the borrow in the issue/PR.

## Sources

- **[OpenClaw](https://github.com/openclaw/openclaw/tree/372b527da4a1cee5b819e7852f6e26ef11160e85)** —
  inspiration, not a claimed five-folder taxonomy. Specific borrows: an explicit
  [cron service facade](https://github.com/openclaw/openclaw/blob/372b527da4a1cee5b819e7852f6e26ef11160e85/src/cron/service-contract.ts#L27-L45),
  [Croner time-zone evaluation](https://github.com/openclaw/openclaw/blob/372b527da4a1cee5b819e7852f6e26ef11160e85/src/cron/schedule.ts#L13-L55),
  [fresh isolated sessions](https://github.com/openclaw/openclaw/blob/372b527da4a1cee5b819e7852f6e26ef11160e85/docs/automation/cron-jobs.md#L203-L220),
  and an installed [service version stamp](https://github.com/openclaw/openclaw/blob/372b527da4a1cee5b819e7852f6e26ef11160e85/src/daemon/service-env.ts#L430-L446).
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
| `@earendil-works/pi-coding-agent` `0.78.0` | `src/agent/` and `src/cli/interactive.ts` — session build, tools, skills, saved sessions, and pi interactive mode |
| `@earendil-works/pi-ai` `0.78.0` | typed model calls + `Type` schemas for the agent tools (`src/agent/agent.ts`) |
| [`croner`](https://github.com/Hexagon/croner) `10.0.1` | `src/scheduler/schedule.ts` — cron expression and IANA time-zone math only |

For pi-facing behavior, search the live [pi package catalog](https://pi.dev/packages) plus
npm/GitHub before building local behavior; cite the adopted package or rejection reason in
the issue/PR.
