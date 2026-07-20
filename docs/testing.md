---
title: "Testing"
summary: "Test tiers, hermetic rule, and the checks CI runs"
read_when:
  - Adding or placing a test
  - Running checks locally before a PR
---

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

**Fixtures.** Built inline; promote into `fixtures/<format>/` once reused across ≥2
tests. Split by transcript format (each a distinct parser) — Conductor/Superset are hosts.
Committed fixtures must be sanitized: no personal paths, repos, or names.

## Running

```sh
npm test                                              # hermetic: unit + integration + e2e
npm run typecheck                                     # tsc: root src + workspaces
npm run lint                                          # oxlint
npm run test:integration                              # one tier
npm run poll:smoke                                    # smoke — reads your live sessions
npm run test:agent                                    # live — needs model auth, paid
OO_RUN_LIVE_ACP_TEST=1 npm run test:agent-runs:live   # real Claude/acpx kill + resume
cd apps/widget && swift test                          # widget (Swift)
```

CI runs on every PR and every landing on `main`: [`ci.yml`](../.github/workflows/ci.yml);
the widget suite: [`widget.yml`](../.github/workflows/widget.yml) (macOS, path-filtered).
