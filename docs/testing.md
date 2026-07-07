# Testing

Guards the read path: scan session files off disk → resolve thread state → serve the
widget/gateway state. Model-free and deterministic, so it's tested for real, no model.

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
| `src/gateway/store.test.ts`, `threads-db.test.ts` | unit | store seams, injected clock |
| `src/gateway/gateway.boundaries.test.ts` | unit | dependency rule: gateway imports no pi, no agent/CLI |
| `src/gateway/poller.integration.test.ts` | integration | real poller + store; done-status regression |
| `src/gateway/poller.scan.integration.test.ts` | integration | real scan path → `ScanRow` mapping |
| `test/scan.integration.test.ts` | integration | real `scan-active-transcripts.mjs` subprocess over session files + git |
| `src/gateway/daemon.e2e.test.ts` | e2e | in-process daemon, ephemeral port, SSE, schedules, triggers (fake scan seam) |
| `src/gateway/poller.smoke.ts` | smoke | "today" digest against the live machine |
| `src/agent/agent.behavior.ts` | live | real agent; asserts it returns prose |

## Layout

```
test/
  run.mjs                    root src tier runner
  scan.integration.test.ts   real scan subprocess over session files + git
  sessions-grep.integration.test.ts

src/gateway/test/
  helpers/index.ts           tempOoHome, fakeScanRow, waitFor
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
