# Testing

How we guard the loop (`glance → drill → prompt → pull back up`) against regressions. Sister
doc to [architecture.md](./architecture.md).

The spine of the suite is the **read path** — scan session files off disk → resolve thread
state → project the sidebar. It's model-free and deterministic, so we test it for real, no model.

## Tiers

Tier = **filename suffix**, colocated with the code it covers. Cross-cutting tests live under
[`harness/test/`](../harness/test/).

| Tier | Suffix | Model? | Disk/Net | Default `npm test`? | Proves |
|------|--------|--------|----------|---------------------|--------|
| **unit** | `*.test.ts` | no | none | ✅ | one module in isolation |
| **integration** | `*.integration.test.ts` | no | temp `HOME`/`OO_HOME` | ✅ | several modules over real fixtures (scan→resolve, poller→store) |
| **e2e** | `*.e2e.test.ts` | no | ephemeral port / subprocess | ✅ | a whole surface (daemon HTTP+SSE, `oo` CLI) |
| **smoke** | `*.smoke.ts` | no | **live machine** | ❌ manual | the real digest against *your* sessions — sanity, not assertion |
| **live** | `*.behavior.ts` / `*.live.test.ts` | **yes (paid)** | real model | ❌ gated | the model returns a valid `Thread[]` |

**Hermetic rule.** Default `npm test` never makes a paid call, hits a live model, or reads
your real sessions — every default tier points `HOME`/`OO_HOME` at a fresh `mkdtemp` dir and
tears it down. `live` is opt-in (auto-skips without auth); `smoke` is run by hand. (The whole
pi ecosystem enforces this split.)

## Where things are today

| File | Tier | Notes |
|------|------|-------|
| `packages/core/src/*.test.ts` | unit | resolve, status, sidebar, blacklist, session-sources, gui-hosts, settings |
| `harness/src/store.test.ts`, `threads-db.test.ts` | unit | seam logic, injected clock |
| `harness/src/poller.integration.test.ts` | integration | real poller + store; done-status regression |
| `harness/src/poller.scan.integration.test.ts` | integration | the **real scan path** — `StatusPoller` (no seam) runs `runScan` over a temp `$HOME`; pins the scan→`ScanRow` mapping the seam tests bypass |
| `harness/src/scan.integration.test.ts` | integration | the real `get-active-threads.mjs` subprocess over real-shaped sessions + git; resolver/finder/blacklist contract |
| `harness/src/daemon.e2e.test.ts` | e2e | in-process daemon, ephemeral port, SSE, schedules, triggers — **fake scan seam by design** (real scan path lives in `poller.scan.integration`) |
| `harness/src/poller.smoke.ts` | smoke | real "today" digest against the live machine |
| `harness/src/agent.behavior.ts` | live | runs the real agent; asserts the `Thread[]` contract, not content |

## Layout

```
harness/test/
  run.mjs                    tier runner — globs *.<tier>.test.ts under harness, fail-fast
  fixtures/<source>/         sanitized session corpus, one dir per source — scaffolded,
    claude/ codex/             empty until the first real fixture lands
    cursor/ posthog-code/
  helpers/index.ts           tempOoHome, fakeScanRow, waitFor
  e2e/                       cross-cutting full-stack tests (e.g. the real `oo` CLI)
```

Module-bound tests stay **colocated** with their source; `harness/test/` holds only shared
infra + cross-cutting e2e. Tiers are **discovered by suffix** — drop a `*.integration.test.ts`
and `run.mjs` picks it up. (`packages/core` is unit-only → keeps its enumerated `test`.)

**Fixtures.** Built inline today (`scan.integration.test.ts` writes session files
programmatically — explicit, and timestamps stay relative). Promote into `fixtures/<source>/`
once reused across ≥2 tests or too bulky. Split axis is **source** (the four
`KNOWN_SESSION_SOURCES`, each a distinct parser); **Conductor/Superset are hosts, not sources**
— a cwd-marker variant inside a source's fixture, never their own dir. Committed fixtures must
be sanitized (no personal paths/repos/names).

## Running

```sh
npm test                                              # hermetic: unit + integration + e2e
npm run typecheck                                     # tsc across workspaces
npm run -w @owner-operator/harness test:integration   # one tier
npm run -w @owner-operator/harness poll:smoke         # smoke — reads your live sessions
npm run -w @owner-operator/harness test:agent         # live — needs model auth, paid
```

## Borrowed patterns

From the pi ecosystem + adjacent local-first agents (all ship real local integration/e2e; none run a live model in CI):

- **pi** — faux LLM provider (scriptable queue), asserts on the event stream; `regressions/<issue#>-<slug>.test.ts`. *Take:* faux seam for model-driven triage; issue-keyed regressions.
- **OpenClaw** — real daemon in-process on an ephemeral port, `mkdtemp` state dir; writes real session files → reads back over HTTP+SSE; `expect.poll`. *Take:* ephemeral-port hermetic daemon e2e; poll-until over sleeps.
- **opencode** — hermetic preload redirects env + deletes creds; fakes the model at the provider boundary; route-coverage gate; `TestClock`. *Take:* `OO_HOME` redirect; a route-coverage gate for the daemon; deterministic clock.
- **Hermes** — per-test `HOME` pre-scaffolded with `sessions/`/`cron/`; live-system guard; contracts over snapshots. *Take:* pre-scaffolded temp `OO_HOME`; contracts, never frozen counts.

## Next

Done: tier suffixes · `run.mjs` runner · shared helpers · real scan path covered. Daemon keeps the fake seam by design (`runScan` is covered a layer down).

- **`oo` CLI e2e** — `harness/test/e2e/`: launch the real binary, assert a `--json` snapshot.
- **Live tier gate** — env-gate `agent.behavior.ts` (`OO_LIVE_TEST=1`) to auto-skip.
