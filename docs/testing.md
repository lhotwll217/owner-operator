# Testing

Guards the four public seams: state, session monitor, scheduler, and Gateway/daemon end to end.
Default tests are model-free and deterministic.

## Tiers

Tier = filename suffix, colocated with the code it covers. Cross-cutting tests live in
[`test/`](../test/).

| Tier | Suffix | Model? | Disk/Net | In `npm test`? | Proves |
|------|--------|--------|----------|----------------|--------|
| unit | `*.test.ts` | no | none | yes | one module in isolation |
| integration | `*.integration.test.ts` | no | temp `HOME`/`OO_HOME` | yes | several modules over real fixtures |
| e2e | `*.e2e.test.ts` | no | ephemeral port / subprocess | yes | a whole surface (daemon HTTP+SSE, `oo` CLI) |
| smoke | `*.smoke.ts` | no | live machine | no (manual) | the digest against your real sessions |
| live | `*.behavior.ts` / `*.live.test.ts` | yes (paid) | real model | no (gated) | the agent can answer in prose |

**Hermetic rule.** Default `npm test` never makes a paid call, hits a live model, or reads
your real sessions — each default tier points `HOME`/`OO_HOME` at a fresh `mkdtemp` and tears
it down. `live` is opt-in (auto-skips without auth); `smoke` is run by hand.

## What's covered today

| File | Tier | Covers |
|------|------|--------|
| `packages/core/src/*.test.ts` | unit | resolve, status, session-state, blacklist, session-sources, gui-hosts, settings |
| `packages/core/src/*.integration.test.ts` | integration | owned harness files and onboarding config/detection |
| `src/state/event-bus.test.ts` | unit | fail-isolated in-memory post-commit wake-ups |
| `src/state/state.integration.test.ts` | integration | SQLite sole writer, projections, and watermarks |
| `src/state/query.integration.test.ts` | integration | State-owned read-only progressive SQL surface |
| `src/scheduler/schedule.test.ts` | unit | calendar math |
| `src/scheduler/scheduler.integration.test.ts` | integration | job lifecycle and durable outcomes |
| `src/scheduler/*.integration.test.ts` | integration | needs-you batching and durable dedupe |
| `src/session-monitor/*.integration.test.ts` | integration | scan reconciliation and async enrichment |
| `src/gateway/gateway.boundaries.test.ts` | unit | transport owns no process/model runtime; no app code in skills |
| `src/gateway/client.integration.test.ts` | integration | long operations and daemon replacement/reconnect behavior |
| `src/agent/skills.integration.test.ts` | integration | product skill discovery from the Agent directory |
| `src/agent/privacy-tools.integration.test.ts` | integration | blacklist enforcement across Pi file primitives |
| `src/agent/*.integration.test.ts` | integration | owned Pi config, onboarding, doctor, permissions, and privacy tools |
| `src/daemon/fingerprint.integration.test.ts` | integration | runtime fingerprint changes with source/settings content |
| `test/eval-daemon.integration.test.ts` | integration | managed eval daemon readiness and shutdown cleanup |
| `test/scan.integration.test.ts` | integration | real `scan-active-transcripts.mjs` subprocess over session files + git |
| `test/sessions-grep.integration.test.ts` | integration | vendored session search, privacy filtering, and Owner Operator transcript targeting |
| `src/daemon/runtime.e2e.test.ts` | e2e | daemon composition, readiness, Gateway, SSE, schedules, query routing |
| `src/daemon/ensure.e2e.test.ts` | e2e | stale-daemon replacement through the installed process supervisor |
| `src/session-monitor/monitor.smoke.ts` | smoke | "today" digest against the live machine |
| `src/agent/agent.behavior.ts` | live | real agent; asserts it returns prose |

## Layout

```
test/
  run.mjs                    root src tier runner
  eval-daemon.integration.test.ts
  scan.integration.test.ts   real scan subprocess over session files + git
  sessions-grep.integration.test.ts

src/gateway/test/
  helpers/index.ts           cross-seam tempOoHome, fakeScanRow, waitFor
```

Tests stay colocated with their source; root `test/` holds cross-cutting integration tests.
Tiers are discovered by suffix — drop a `*.integration.test.ts` under the runner's roots and
`run.mjs` picks it up.

**Fixtures.** Built inline today; promote into `fixtures/<source>/` once reused across ≥2
tests. Split by source (each a distinct parser) — Conductor/Superset are hosts, not sources.
Committed fixtures must be sanitized: no personal paths, repos, or names.

## Running

```sh
npm test                                              # hermetic: unit + integration + e2e
npm run typecheck                                     # tsc: root src + workspaces
npm run test:integration                              # one tier
npm run poll:smoke                                    # smoke — reads your live sessions
npm run test:agent                                    # live — needs model auth, paid
```
