---
title: "Inspiration"
summary: "Accepted open source borrows with pinned sources; check before designing anything new"
read_when:
  - Before building a new system, feature, or integration (don't reinvent)
  - Recording an adopted borrow
---

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
  LaunchAgent [enable → kickstart → bootstrap recovery](https://github.com/openclaw/openclaw/blob/d4e93e791bc5/src/daemon/launchd.ts#L656-L684),
  and the [docs-list script](https://github.com/openclaw/openclaw/blob/372b527da4a1cee5b819e7852f6e26ef11160e85/scripts/docs-list.js#L1-L179)
  behind `npm run docs:list` (frontmatter routing: `summary` + `read_when` per page).
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
  Its combined instance record is not borrowed: it embeds separate fields for each upstream
  agent session instead of one extensible reference
  ([fields](https://github.com/asheshgoplani/agent-deck/blob/350a640649d9c4d6b52524030f63d426dcd309d0/internal/session/instance.go#L184-L220)).
- **Herdr** — borrowed the separation of host workspace/pane identity from an opaque upstream
  agent-session reference
  ([snapshot](https://github.com/ogulcancelik/herdr/blob/3a8490f6515dfea13292ae28e34f1174d2f68af1/src/persist/snapshot.rs#L11-L29),
  [reference](https://github.com/ogulcancelik/herdr/blob/3a8490f6515dfea13292ae28e34f1174d2f68af1/src/persist/snapshot.rs#L97-L116)).
  Its separate detection and integration enums are not borrowed: their membership drifts
  ([detection](https://github.com/ogulcancelik/herdr/blob/3a8490f6515dfea13292ae28e34f1174d2f68af1/src/detect/mod.rs#L41-L89),
  [integration](https://github.com/ogulcancelik/herdr/blob/3a8490f6515dfea13292ae28e34f1174d2f68af1/src/api/schema/integrations.rs#L13-L30)).
  Herdr is AGPL-3.0-or-later/commercial, so no code was copied
  ([license declaration](https://github.com/ogulcancelik/herdr/blob/3a8490f6515dfea13292ae28e34f1174d2f68af1/README.md#L81-L88)).
- **Paperclip** — borrowed stable runtime identity, adapter-owned native session decoding, and a
  versioned parser boundary
  ([Pi codec](https://github.com/paperclipai/paperclip/blob/ce7dedf33d2689673826ffdcfd6af7ee06be39af/packages/adapters/pi-local/src/server/index.ts#L7-L49),
  [parser contract](https://github.com/paperclipai/paperclip/blob/ce7dedf33d2689673826ffdcfd6af7ee06be39af/server/src/adapters/plugin-loader.ts#L82-L109)).
  Its dynamic adapter/plugin system is not borrowed; a closed local catalog is enough here.
- **Harnss** — borrowed the distinction between an engine ID and a concrete installed agent
  ([types](https://github.com/OpenSource03/harnss/blob/dc1dfd8a33caa46a1eefcfe9e14697b27ac4c33d/shared/types/engine.ts#L19-L28),
  [installed record](https://github.com/OpenSource03/harnss/blob/dc1dfd8a33caa46a1eefcfe9e14697b27ac4c33d/shared/types/registry.ts#L8-L25)).
  Its remote agent store is not borrowed: Owner Operator does not install or update harnesses.
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
| `jsonc-parser` `3.3.1` | `packages/core/src/permissions.mjs` — parse and locate Pi's comment-bearing config ([source](https://github.com/microsoft/node-jsonc-parser/blob/3c9b4203d663061d87d4d34dd0004690aef94db5/src/main.ts#L100-L114)), then apply targeted edits without replacing the document ([source](https://github.com/microsoft/node-jsonc-parser/blob/3c9b4203d663061d87d4d34dd0004690aef94db5/src/main.ts#L400-L423)) |

Permission gating is adopted wholesale from
[`@gotgenes/pi-permission-system`](https://pi.dev/packages/pi-permission-system). The full
contract, with every claim pinned to the extension's source, lives in
[agent.md — Permissions](agent.md#permissions).

For pi-facing behavior, search the live [pi package catalog](https://pi.dev/packages) plus
npm/GitHub before building local behavior; cite the adopted package or rejection reason in
the issue/PR.
