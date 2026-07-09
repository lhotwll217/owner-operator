# Architecture

> **Status: settlement in progress (2026-07-09).** This supersedes the prior version, which
> justified one state-owning gateway as "OpenClaw's layout." That claim was never verified against
> OpenClaw source — it was a slogan, and it is wrong (see [The failure](#the-failure)). Below: the
> **verified** OpenClaw reference, the OO **target**, a **file-by-file** map, and the **guardrails that
> land before any code moves**. Folders marked `(target)` do not exist yet.

## The failure

`src/gateway/daemon.ts` opens with *"openclaw's gateway pattern"* and then makes one file own the
poll loop, scan, resolver, store, scheduler, and push stream. The old docs codified it:
*"GATEWAY — reads sessions · owns state · runs schedules."* We never listed OpenClaw's `src/` to
check. When we finally did (session `68b87ac4`, 2026-07-09), the reference turned out to say the
**opposite**: OpenClaw *separates* every concern we merged. The slogan drove the design; the source
was never read. This doc fixes that — every OpenClaw claim is pinned to a path at a commit.

## Reference — OpenClaw, verified

Read from the repo on disk at `openclaw/openclaw@372b527` (not inferred from filenames). Permalink base:
`https://github.com/openclaw/openclaw/blob/372b527da4a1cee5b819e7852f6e26ef11160e85/`.

| Concern | OpenClaw home | Verified by |
|---|---|---|
| **Wire contract** (types/schema) | `packages/gateway-protocol` — `@openclaw/gateway-protocol`, dep: `typebox` only | `packages/gateway-protocol/{package.json,src/schema.ts,src/frame-guards.ts}` |
| **Client SDK** | `packages/gateway-client` — deps: `gateway-protocol`, `ws` | `packages/gateway-client/package.json` |
| **Reusable agent core** | `packages/agent-core` — "agent loop … session storage *contracts*" | `docs/agent-runtime-architecture.md`, `packages/agent-core/package.json` |
| **Server / transport** | `src/gateway/` — HTTP/WS, auth, control-plane, events, connections. No store, no model. | `src/gateway/AGENTS.md` ("Gateway HTTP/server code"; "keep pollers … disabled in RPC tests"); 500+ `auth-*`/`control-*`/`connection-*` files |
| **Process / OS-service** | `src/daemon/` — `launchd.ts`, `systemd.ts`, `schtasks.ts`, `service.ts`, `node-service.ts` | `src/daemon/gateway-entrypoint.ts`: *"Resolves gateway dist entrypoints used by installed daemon command lines."* The daemon **installs & launches** the gateway; it is not the store. |
| **Canonical store** (data) | `src/state/` — `openclaw-state-db.ts`, `openclaw-state-schema.sql` | `AGENTS.md` L76: *"Runtime reads/writes the canonical store only."* |
| **Status projection** (read model) | `src/status/` — `status-text.ts`, `status-message.ts` (pure) | `src/status/` listing |
| **Producers** (ingest, schedules) | `src/agents/sessions/`, `src/cron/`, `src/tasks/` — **siblings of** `src/gateway/`, outside it | top-level `src/` listing; `src/agents/sessions/event-bus.ts` (cited in #44) |
| **Skills** (model instructions) | `skills/*.md`, discovered via `package.json` manifest — never app runtime | `docs/agent-runtime-architecture.md` (Manifests) |

**The one lesson:** OpenClaw's boundary is *separation*. Server ≠ store ≠ process-lifecycle ≠
producers ≠ skills — each its own dir or scoped package. `packages/*` hold **reusable, published**
libraries (and the wire contract as its own package); **app-specific** logic (`src/status`,
`src/state`, `src/agents`) stays in `src/`.

## Where OO diverged

`src/gateway/daemon.ts` is the inversion in one file — it *owns the poll loop (scan + resolver +
store), the schedule/trigger runner, and the push stream* ([daemon.ts:1-13](../src/gateway/daemon.ts)),
and the poller `execFile`s an agent-skill script every tick
([poller.ts:23](../src/gateway/poller.ts)). OpenClaw puts each of those in a different place. Three
open bugs are all symptoms of the merge: **#46** (app runtime in `.agents/skills/`), **#44** (two
sources of truth for state), **#45** (enrichment producer deleted, unnoticed).

## Target — OO, sized for a local single process (KISS)

OO is one local-first binary, not a 380k-star distributed gateway. We take OpenClaw's **boundaries**,
not its dir count. OO has no OS-service installer layer, so there is no `src/daemon/` equivalent — the
`oo daemon` *command* is the composition root that wires the modules.

```
packages/core/          PURE, reusable (@owner-operator/core). Wire protocol + pure domain fns
                        (resolve · session-sources · gui-hosts · status · session-state projection ·
                        settings · blacklist). No I/O, no model, no writes.        [OpenClaw: packages/*]

src/store/      (target)  DATA — the append-only thread_details ledger = single source of truth.
                        threads-db · store (the ONE guarded write path) · session-state query ·
                        schema-docs · query-db.                                     [OpenClaw: src/state/]

src/poll/       (target)  PRODUCER (ingest, model-free). scan.ts (IMPORTED, was an execFile'd .mjs) +
                        poller.ts: scan → resolve → store.record.        [OpenClaw: producer, outside gateway]

src/enrichment/ (target)  PRODUCER (model). worker.ts: on state edge → pi-ai typed complete() →
                        {title,summary,nextSteps,priority} → POST /details. Model lives HERE. [fixes #45]

src/scheduler/  (target)  PRODUCER (time/event). the schedule + trigger runner, lifted out of the server.

src/gateway/            SERVER ONLY. server.ts (HTTP+SSE transport + endpoints) · client.ts.
                        No poll, no scan, no store writes of its own, no model.    [OpenClaw: src/gateway/]

src/runtime.ts  (target)  COMPOSITION ROOT (the `oo daemon` command). initStore → startServer →
                        startPoller → startEnrichment → startScheduler. Modules don't self-wire.
                                                                       [OpenClaw: src/daemon boots the gateway]

src/agent/ · src/cli/   CLIENTS. Read state via the gateway; typed tools; never touch fs for state.
apps/widget/            CLIENT. GET /session-state + SSE. Owns a decode CONTRACT test (below).

.claude/skills/         AGENT SKILLS = SKILL.md model instructions only. No app code, no execFile.
(.agents/skills/ → gone)                                                                    [fixes #46]
```

Dependency rule (unchanged direction, corrected owners):

```text
core ← store ← { poll, enrichment, scheduler, gateway } ← runtime ← { agent, cli, widget }
```

- **The store is the only writer path.** Everything mutates state through `src/store/`
  (`appendDetailsInTx`). The server no longer owns state; it *serves* the store's projection.
- **The gateway is transport.** It reads the store's `listSessionState` projection and broadcasts
  change nudges. It runs no scan, no poll, no model — enforced, not asserted (guardrail 2).
- **`packages/core` stays pure.** It already is: `session-state.ts` there is the pure
  `toSessionStateThreads` transform; the DB-reading query (`getCurrentSessionStateRows`) is what moves
  to `src/store/`. Pure transform in `core`, I/O query in `store`.

## File-by-file migration

| From | To | Why |
|---|---|---|
| `src/gateway/threads-db.ts` · `store.ts` · `schema-docs.ts` · `query-db.ts` | `src/store/` | data layer, not the server |
| `src/gateway/session-state.ts` (`getCurrentSessionStateRows`) | `src/store/` | it reads the DB (the pure transform stays in `packages/core`) |
| `src/gateway/poller.ts` | `src/poll/poller.ts` | producer (ingest), not the server |
| `.agents/skills/scan-active-transcripts/scan-active-transcripts.mjs` | `src/poll/scan.ts` (imported) | app code — delete the `execFile` + JSON round-trip |
| `.agents/skills/scan-active-transcripts/SKILL.md` | delete | loaded by nothing (pi skills are off) |
| `.agents/skills/sessions-grep/` + vendored `session-grep` | `vendor/session-grep/` (imported) | keep the engine, relocate out of skills |
| `src/gateway/daemon.ts` → HTTP+SSE server | `src/gateway/server.ts` | it's the server; rename off the "daemon" overload |
| `src/gateway/daemon.ts` → schedule/trigger runner | `src/scheduler/` | producer, not transport |
| `src/gateway/daemon.ts` → "what starts what" | `src/runtime.ts` (`oo daemon`) | composition root |
| `src/gateway/client.ts` | stays `src/gateway/` | client seam (revisit as a package later) |
| `packages/core/*` | stays | already pure — keep it that way |
| `in_snapshot` column · `StatusSnapshot` · `GET /snapshot` · `reconcile`/`diffSnapshots` | delete | second read model that should be derived (#44) |
| `.agents/skills/{get-current-session-state,mark-done,session-keywords}` | already deleted | dead |

**Module boundary ≠ process boundary.** The `oo daemon` process still hosts server + poll +
enrichment + scheduler. They are separate *modules* writing through the store — not one tangled file.

## Guardrails — land these as failing tests FIRST

The old boundary test checked *imports* only, so app-runtime-via-`execFile` and a state-owning server
both read green. Before moving any code, add checks that fail on the target violations. Red now; each
goes green as its phase lands.

1. **No app runtime in a skills dir.** Fail if any `src/**` file `execFile`/`spawn`s a path under
   `.agents/skills` or `.claude/skills`, or imports from it. (Extends
   [gateway.boundaries.test.ts](../src/gateway/gateway.boundaries.test.ts), which only greps imports.) — #46
2. **Gateway is server-only.** In `src/gateway/`: forbid imports of `poll`/`scan`/`store`-write/model,
   and forbid `child_process` entirely.
3. **Store is the sole writer.** Only `src/store/` contains the DB write path; no other module opens the
   ledger for write.
4. **Widget decode contract.** Assert the widget's `SessionStateRow` decodes a **real** `/session-state`
   payload — a golden capture from `getCurrentSessionStateRows`, not a synthetic fixture. Fails if the
   server renames a field the widget reads (`generatedTopic`/`summary`/`nextSteps`/`priority`/`active`/
   `state`/`num`). The widget decodes leniently ([Model.swift:52](../apps/widget/Sources/oo-widget/Model.swift)),
   so a rename **silently blanks a row** instead of erroring — exactly #45's failure mode.
5. **Docs match folders.** Fail if a `src/…` path named in this file doesn't exist (excluding lines
   tagged `(target)`). This is the check that would have caught "gateway owns state" drifting from reality.
6. **One source of truth for state.** After #44: fail if `in_snapshot` / `StatusSnapshot` symbols
   survive anywhere; `/session-state` is the only read model.

## Sequencing (maps to the open issues)

- **Phase 0 — now.** Freeze architecture PRs. This doc. Guardrails 1–5 land as failing tests, pinning
  the target.
- **Phase 1 — #46.** Move scan + session-grep into `src/`, import them, delete `execFile` and
  `.agents/skills/`. Guardrail 1 → green. (Relates: #20, #8 — the sessions-grep wrapper.)
- **Phase 2 — #44.** Delete `in_snapshot`/`StatusSnapshot`; the ledger + `listSessionState` is the only
  truth. Guardrail 6 → green. (Absorbs #39, #38 — the state-freshness bugs.)
- **Phase 3 — the split.** `daemon.ts` → `src/gateway/server.ts` (server-only) + `src/store/` +
  `src/poll/` + `src/scheduler/` + `src/runtime.ts`. Guardrails 2, 3 → green.
- **Phase 4 — #45.** Build `src/enrichment/worker.ts` — a separate always-on gateway client (pi-ai
  typed `complete()` → `POST /details`). Widget renders `summary`/`nextSteps` again. Guardrail 4 proves it.
- **Downstream, unblocked by this refactor:** #40 (render markdown in the `oo` surface) → then #41
  (derive thematic workstreams, skill-first). #41's data model builds *on top of* the settled ledger,
  not inside this refactor.

## Schedules & triggers

The `oo daemon` composition root runs them (shapes in `packages/core/src/protocol.ts`); the runner
lives in `src/scheduler/`, not the server. A schedule is WHEN × ACTION, set by name over HTTP.
`interval`/`daily` run from the tick loop; `event: needs-you` fires when a thread newly needs you.
Actions: `poll` and `shell`.

```sh
curl -X PUT localhost:47711/schedules/morning-brief \
  -d '{"when":{"type":"daily","at":"08:00"},"action":{"type":"shell","command":"oo --session-state > ~/brief.json"}}'
```
