---
title: "Inspiration"
summary: "Adopted open source borrows with pinned sources"
read_when:
  - Before building a new system, feature, or integration
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
  behind `npm run docs:list`. For delegated runs
  ([#69](https://github.com/lhotwll217/owner-operator/issues/69)), its ACP control-plane
  patterns (studied, MIT, pinned at `6bd9e5f158f7b5dcb54491425ee54135abecc825`): a
  runtime-agnostic durable task ledger with per-runtime adapters and monotonic terminal states
  ([tasks](https://github.com/openclaw/openclaw/blob/6bd9e5f158f7b5dcb54491425ee54135abecc825/docs/automation/tasks.md)),
  liveness as an in-process active-turn set plus durable rows — never persisted metadata alone
  ([active-turns](https://github.com/openclaw/openclaw/blob/6bd9e5f158f7b5dcb54491425ee54135abecc825/src/acp/control-plane/active-turns.ts#L1-L47)),
  the control plane owning its own turn deadline because a launcher timeout after partial output
  reads as completion
  ([runtime](https://github.com/openclaw/openclaw/blob/6bd9e5f158f7b5dcb54491425ee54135abecc825/extensions/acpx/src/runtime.ts#L80-L87)),
  and two-level resume identity (harness session id + acpx record id)
  ([handle-ensure](https://github.com/openclaw/openclaw/blob/6bd9e5f158f7b5dcb54491425ee54135abecc825/src/acp/control-plane/manager.runtime-handle-ensure.ts#L95-L154)).
  Its gateway control plane and product delivery are not borrowed: Owner Operator's daemon
  already owns durable runs (the scheduler substrate), so delegated runs extend that rather than
  adopt OpenClaw's.
- **[pi-subagents](https://github.com/nicobailon/pi-subagents/tree/c940fe20e86d9ba429eebcac809ec79d478ef206)**
  (design donor, not a dependency) — its versioned lifecycle-artifact contract and lifecycle
  state names informed the `agent_runs` shape
  ([types](https://github.com/nicobailon/pi-subagents/blob/c940fe20e86d9ba429eebcac809ec79d478ef206/src/shared/types.ts#L34),
  [README](https://github.com/nicobailon/pi-subagents/blob/c940fe20e86d9ba429eebcac809ec79d478ef206/README.md#L257-L279)).
  Not adopted as an execution layer: it orchestrates pi children only, while
  [#69](https://github.com/lhotwll217/owner-operator/issues/69) spans pi, Codex, and Claude.
  The [Pi bundled subagent example](https://github.com/earendil-works/pi/blob/f4e9ca7466b5576090d1093c27fe38d73909f3d2/packages/coding-agent/examples/extensions/subagent/README.md)
  is a further design donor (spawn-and-parse is a few hundred lines) but foreground-only with no
  persistence, so it is not vendored.
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
| `@earendil-works/pi-coding-agent` | `src/agent/` and `src/cli/interactive.ts` — session build, tools, skills, saved sessions, and pi interactive mode |
| `@earendil-works/pi-ai` | typed model calls + `Type` schemas for the agent tools (`src/agent/agent.ts`) |
| [`croner`](https://github.com/Hexagon/croner) | `src/scheduler/schedule.ts` — cron expression and IANA time-zone math only |
| [`acpx`](https://github.com/openclaw/acpx) (MIT, pinned `0.11.2`) | `src/agent-runs/acp-launcher.ts` — the Agent Client Protocol wire runtime for delegated children (spawn, handshake, per-harness launch registry, resume, typed event stream) on the official ACP SDK; Owner Operator keeps the control plane (the `agent_runs` executor) |
| `jsonc-parser` | `packages/core/src/permissions.mjs` — parse and locate Pi's comment-bearing config ([source](https://github.com/microsoft/node-jsonc-parser/blob/3c9b4203d663061d87d4d34dd0004690aef94db5/src/main.ts#L100-L114)), then apply targeted edits without replacing the document ([source](https://github.com/microsoft/node-jsonc-parser/blob/3c9b4203d663061d87d4d34dd0004690aef94db5/src/main.ts#L400-L423)) |

Permission gating is adopted wholesale from
[`@gotgenes/pi-permission-system`](https://pi.dev/packages/pi-permission-system). The full
contract, with every claim pinned to the extension's source, lives in
[agent.md — Permissions](agent.md#permissions).

For pi-facing behavior, search the live [pi package catalog](https://pi.dev/packages) plus
npm/GitHub before building local behavior; cite the adopted package or rejection reason in
the issue/PR.
