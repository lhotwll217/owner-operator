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
- **Agent Deck** — borrowed one canonical, ordered tool registry and exact-set regression tests
  ([registry contract](https://github.com/asheshgoplani/agent-deck/blob/350a640649d9c4d6b52524030f63d426dcd309d0/internal/session/toolregistry.go#L15-L33),
  [canonical test](https://github.com/asheshgoplani/agent-deck/blob/350a640649d9c4d6b52524030f63d426dcd309d0/internal/session/toolregistry_test.go#L8-L27)).
  Its combined instance record was rejected because it embeds separate fields for each upstream
  agent session instead of one extensible reference
  ([fields](https://github.com/asheshgoplani/agent-deck/blob/350a640649d9c4d6b52524030f63d426dcd309d0/internal/session/instance.go#L184-L220)).
- **Herdr** — borrowed the separation of host workspace/pane identity from an opaque upstream
  agent-session reference
  ([snapshot](https://github.com/ogulcancelik/herdr/blob/3a8490f6515dfea13292ae28e34f1174d2f68af1/src/persist/snapshot.rs#L11-L29),
  [reference](https://github.com/ogulcancelik/herdr/blob/3a8490f6515dfea13292ae28e34f1174d2f68af1/src/persist/snapshot.rs#L97-L116)).
  Its separate detection and integration enums were rejected because their membership drifts
  ([detection](https://github.com/ogulcancelik/herdr/blob/3a8490f6515dfea13292ae28e34f1174d2f68af1/src/detect/mod.rs#L41-L89),
  [integration](https://github.com/ogulcancelik/herdr/blob/3a8490f6515dfea13292ae28e34f1174d2f68af1/src/api/schema/integrations.rs#L13-L30)).
  Herdr is AGPL-3.0-or-later/commercial, so no code was copied
  ([license declaration](https://github.com/ogulcancelik/herdr/blob/3a8490f6515dfea13292ae28e34f1174d2f68af1/README.md#L81-L88)).
- **Paperclip** — borrowed stable runtime identity, adapter-owned native session decoding, and a
  versioned parser boundary
  ([Pi codec](https://github.com/paperclipai/paperclip/blob/ce7dedf33d2689673826ffdcfd6af7ee06be39af/packages/adapters/pi-local/src/server/index.ts#L7-L49),
  [parser contract](https://github.com/paperclipai/paperclip/blob/ce7dedf33d2689673826ffdcfd6af7ee06be39af/server/src/adapters/plugin-loader.ts#L82-L109)).
  Its dynamic adapter/plugin system was rejected; a closed local catalog is enough here.
- **Harnss** — borrowed the distinction between an engine ID and a concrete installed agent
  ([types](https://github.com/OpenSource03/harnss/blob/dc1dfd8a33caa46a1eefcfe9e14697b27ac4c33d/shared/types/engine.ts#L19-L28),
  [installed record](https://github.com/OpenSource03/harnss/blob/dc1dfd8a33caa46a1eefcfe9e14697b27ac4c33d/shared/types/registry.ts#L8-L25)).
  Its remote agent store was rejected because Owner Operator does not install or update harnesses.
- **Conductor** — validated that a workspace host and the harness running inside it are separate:
  one workspace may run Claude Code, Codex, Cursor, or OpenCode
  ([workspace guide](https://www.conductor.build/docs/first-workspace),
  [workspace model](https://www.conductor.build/docs/concepts/workspaces-and-branches)).
- **Superset** — its worktree home is configurable globally and per project, so host detection
  reads those settings instead of assuming `~/.superset/worktrees`
  ([schema](https://github.com/superset-sh/superset/blob/df775f8e62c82758cf37ef47f6a9a20978de4df0/packages/host-service/src/db/schema.ts#L60-L91),
  [resolution](https://github.com/superset-sh/superset/blob/df775f8e62c82758cf37ef47f6a9a20978de4df0/packages/host-service/src/trpc/router/settings/worktree-location.ts#L11-L73)).

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
([source](https://github.com/thurstonsand/pi-permissions/blob/6bed116b0099f2ddfbd1c2f0c985ed45dcf49e1c/src/shell.ts#L130-L150))
behind an Owner Operator extension. Its complete extension was not adopted because its runtime
resolves user and package policy through Pi's global agent directory
([source](https://github.com/thurstonsand/pi-permissions/blob/6bed116b0099f2ddfbd1c2f0c985ed45dcf49e1c/extensions/runtime.ts#L45-L72)).
`@gotgenes/pi-permission-system` was also rejected as a drop-in because it selects project policy
from the task cwd
([source](https://github.com/gotgenes/pi-packages/blob/ca66df6efddffb0dd6e6fafc5707238a1881a075/packages/pi-permission-system/src/permission-manager.ts#L387-L401)).
The adopted parser is macOS-compatible TypeScript plus a WebAssembly Bash grammar, with no
Linux-only sandbox dependency. Version `0.8.0` was released from the pinned
[release commit](https://github.com/thurstonsand/pi-permissions/commit/6bed116b0099f2ddfbd1c2f0c985ed45dcf49e1c)
on the day of this triage, and its upstream suite covers assignments, wrappers, substitutions, flags, and nested
shell payloads
([tests](https://github.com/thurstonsand/pi-permissions/blob/6bed116b0099f2ddfbd1c2f0c985ed45dcf49e1c/test/shell.test.ts#L24-L99)).
Pinning the exact version and retaining only that tested parser keeps maintenance exposure smaller
than adopting its policy/config runtime. The local adapter owns only the product rules: the privacy
blacklist and the documented interactive/headless gate table.

For pi-facing behavior, search the live [pi package catalog](https://pi.dev/packages) plus
npm/GitHub before building local behavior; cite the adopted package or rejection reason in
the issue/PR.
