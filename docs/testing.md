# Testing

Guards the read path: scan session files off disk → resolve thread state → render the
sidebar. Model-free and deterministic, so it's tested for real, no model.

## Tiers

Tier = filename suffix, colocated with the code it covers. Cross-cutting tests live in
[`harness/test/`](../harness/test/).

| Tier | Suffix | Model? | Disk/Net | In `npm test`? | Proves |
|------|--------|--------|----------|----------------|--------|
| unit | `*.test.ts` | no | none | yes | one module in isolation |
| integration | `*.integration.test.ts` | no | temp `HOME`/`OO_HOME` | yes | several modules over real fixtures |
| e2e | `*.e2e.test.ts` | no | ephemeral port / subprocess | yes | a whole surface (daemon HTTP+SSE, `oo` CLI) |
| smoke | `*.smoke.ts` | no | live machine | no (manual) | the digest against your real sessions |
| live | `*.behavior.ts` / `*.live.test.ts` | yes (paid) | real model | no (gated) | the model returns a valid `Thread[]` |

**Hermetic rule.** Default `npm test` never makes a paid call, hits a live model, or reads
your real sessions — each default tier points `HOME`/`OO_HOME` at a fresh `mkdtemp` and tears
it down. `live` is opt-in (auto-skips without auth); `smoke` is run by hand.

## What's covered today

| File | Tier | Covers |
|------|------|--------|
| `packages/core/src/*.test.ts` | unit | resolve, status, sidebar, blacklist, session-sources, gui-hosts, settings |
| `harness/src/gateway/store.test.ts`, `threads-db.test.ts` | unit | store seams, injected clock |
| `harness/src/gateway/gateway.boundaries.test.ts` | unit | dependency rule: gateway imports no pi, no agent/tui/cli |
| `harness/src/gateway/poller.integration.test.ts` | integration | real poller + store; done-status regression |
| `harness/src/gateway/poller.scan.integration.test.ts` | integration | real scan path → `ScanRow` mapping |
| `harness/test/scan.integration.test.ts` | integration | real `get-active-threads.mjs` subprocess over session files + git |
| `harness/src/gateway/daemon.e2e.test.ts` | e2e | in-process daemon, ephemeral port, SSE, schedules, triggers (fake scan seam) |
| `harness/src/gateway/poller.smoke.ts` | smoke | "today" digest against the live machine |
| `harness/src/agent/agent.behavior.ts` | live | real agent; asserts the `Thread[]` contract, not content |

## Layout

```
harness/test/
  run.mjs                    tier runner — globs *.<tier>.test.ts, fail-fast
  fixtures/<source>/         sanitized session corpus, one dir per source
  helpers/index.ts           tempOoHome, fakeScanRow, waitFor
  e2e/                       cross-cutting full-stack tests
```

Tests stay colocated with their source; `harness/test/` holds shared infra + cross-cutting
e2e. Tiers are discovered by suffix — drop a `*.integration.test.ts` and `run.mjs` picks it up.

**Fixtures.** Built inline today; promote into `fixtures/<source>/` once reused across ≥2
tests. Split by source (each a distinct parser) — Conductor/Superset are hosts, not sources.
Committed fixtures must be sanitized: no personal paths, repos, or names.

## Running

```sh
npm test                                              # hermetic: unit + integration + e2e
npm run typecheck                                     # tsc across workspaces
npm run -w @owner-operator/harness test:integration   # one tier
npm run -w @owner-operator/harness poll:smoke         # smoke — reads your live sessions
npm run -w @owner-operator/harness test:agent         # live — needs model auth, paid
```
