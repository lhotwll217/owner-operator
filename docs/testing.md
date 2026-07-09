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
| `src/state/state.test.ts`, `event-bus.test.ts` | unit | sole writer, watermarks, post-commit wake-ups |
| `src/state/query.test.ts` | unit | State-owned read-only progressive SQL surface |
| `src/scheduler/*.test.ts` | unit | calendar math, job lifecycle, durable outcomes |
| `src/scheduler/*.integration.test.ts` | integration | needs-you batching and durable dedupe |
| `src/session-monitor/*.integration.test.ts` | integration | scan reconciliation and async enrichment |
| `src/gateway/gateway.boundaries.test.ts` | unit | transport owns no process/model runtime; no app code in skills |
| `test/scan.integration.test.ts` | integration | real `scan-active-transcripts.mjs` subprocess over session files + git |
| `src/daemon/runtime.e2e.test.ts` | e2e | daemon composition, readiness, Gateway, SSE, schedules, query routing |
| `src/session-monitor/monitor.smoke.ts` | smoke | "today" digest against the live machine |
| `src/agent/agent.behavior.ts` | live | real agent; asserts it returns prose |

## Layout

```
test/
  run.mjs                    root src tier runner
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
