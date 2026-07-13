# Inspiration

Borrow battle-tested, maintained patterns. Check here before designing anything new; hunt
beyond this list when it comes up short; cite the borrow in the issue/PR.

## Sources

- **[OpenClaw](https://github.com/openclaw/openclaw/tree/372b527da4a1cee5b819e7852f6e26ef11160e85)** —
  Specific borrows: an explicit
  [cron service facade](https://github.com/openclaw/openclaw/blob/372b527da4a1cee5b819e7852f6e26ef11160e85/src/cron/service-contract.ts#L27-L45),
  [Croner time-zone evaluation](https://github.com/openclaw/openclaw/blob/372b527da4a1cee5b819e7852f6e26ef11160e85/src/cron/schedule.ts#L13-L55),
  [fresh isolated sessions](https://github.com/openclaw/openclaw/blob/372b527da4a1cee5b819e7852f6e26ef11160e85/docs/automation/cron-jobs.md#L203-L220),
  an installed [service version stamp](https://github.com/openclaw/openclaw/blob/372b527da4a1cee5b819e7852f6e26ef11160e85/src/daemon/service-env.ts#L430-L446),
  and LaunchAgent [enable → kickstart → bootstrap recovery](https://github.com/openclaw/openclaw/blob/d4e93e791bc5/src/daemon/launchd.ts#L656-L684).
- **[Hermes Agent](https://github.com/NousResearch/hermes-agent)** (Nous Research) — proven
  patterns at viral scale: skills grown from experience, persistent memory, one gateway
  process serving many chat surfaces. Pattern source for skills, memory, and surface design.
- **[opencode](https://github.com/sst/opencode)** — widely used local coding agent; a session
  source to read ([#16](https://github.com/lhotwll217/owner-operator/issues/16)) and a
  reference terminal-agent codebase.
- **[session-grep](https://github.com/lhotwll217/session-grep)** — the search primitive we
  vendor ([#20](https://github.com/lhotwll217/owner-operator/issues/20)); house vendoring
  model: the skill wrapper owns local policy (sources, blacklist), and its private `vendor/`
  receives the pinned upstream primitive untouched.

## pi — the toolkit we build on

[pi](https://github.com/earendil-works/pi) ships most agent plumbing (sessions, tools,
skills, extensions, modes); check its toolbox first. Tracked implementations:

| pi piece | Where it runs here |
|---|---|
| `@earendil-works/pi-coding-agent` (pinned in `package.json`) | `src/agent/` and `src/cli/interactive.ts` — session build, tools, skills, saved sessions, and pi interactive mode |
| `@earendil-works/pi-ai` (pinned in `package.json`) | typed model calls + `Type` schemas for the agent tools (`src/agent/agent.ts`) |
| [`croner`](https://github.com/Hexagon/croner) `10.0.1` | `src/scheduler/schedule.ts` — cron expression and IANA time-zone math only |

[`pi-schedule-prompt`](https://pi.dev/packages/pi-schedule-prompt) was considered and rejected
for daemon scheduling: it is a Pi-session timer, while Owner Operator needs SQLite-owned job
intent/history and a fresh isolated Pi session per prompt run. The local scheduler is deliberately
limited to time evaluation, durable claims through `State`, and execution lifecycle.

Permission gates reuse `@thurstonsand/pi-permissions`' parsed shell-command model
([source](https://github.com/thurstonsand/pi-permissions/blob/6bed116b0099f2ddfbd1c2f0c985ed45dcf49e1c/src/shell.ts))
behind an Owner Operator extension. Its complete extension was not adopted because its runtime
resolves user and package policy through Pi's global agent directory
([source](https://github.com/thurstonsand/pi-permissions/blob/6bed116b0099f2ddfbd1c2f0c985ed45dcf49e1c/extensions/runtime.ts#L45-L72)).
`@gotgenes/pi-permission-system` was also rejected as a drop-in because it selects project policy
from the task cwd
([source](https://github.com/gotgenes/pi-packages/blob/ca66df6efddffb0dd6e6fafc5707238a1881a075/packages/pi-permission-system/src/permission-manager.ts#L387-L401)).
The local adapter owns only the product rules: the privacy blacklist and the documented
interactive/headless gate table.

For pi-facing behavior, search the live [pi package catalog](https://pi.dev/packages) plus
npm/GitHub before building local behavior; cite the adopted package or rejection reason in
the issue/PR.
