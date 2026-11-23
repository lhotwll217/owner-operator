# Owner Operator verification map

This directory is the maintained source for verifying Owner Operator's user-facing behavior live on this Mac. Read this index before driving `oo`, then use the matching feature file as the recipe. `scripts/verify-oo.mjs` automates every journey here. Each report row names the feature and check it proves.

## Baseline preconditions

- `oo doctor` prints `Status: ready`, and `/health` reports `stale: false` with the target's `repoRoot` (see the SKILL's Doctor section).
- Each harness to verify has its CLI on `PATH` and is logged in: `claude`, `codex`, `cursor-agent`, `opencode`, `agy`.
- The owner's role files exist: `$OO_HOME/workspace/delegated-worker-instructions.md` and `delegated-child-instructions.md`.
- Drive only the owner's installed daemon or a daemon this run started under a temp `OO_HOME`.

## Driving conventions

- Every turn is `oo runs delegate --harness <h> --no-wait --json --cwd $TMPDIR "<task>"`, with `OO_AGENT` and `OO_AGENT_RUN_LEASE_ID` unset.
- Every task carries a unique nonce (`OOV_<stamp>_<harness>_<kind>`) and asks for exactly that reply. The nonce is the handle for every later lookup.
- Read state through `oo` only: `oo runs get`, `oo session-state list`, `oo db query`, `oo search`. Reading transcript files directly bypasses the reader under test.
- Use `--json` for every assertion.

## Proof and skip reporting

- A run's own `resultTail` proves the harness replied. It does not prove Owner Operator tracked the session. Tracking needs the `threads` row, its latest `thread_details` state, and the transcript reader returning the reply.
- Widget proof pairs a `/session-state` observation with a real `oo-widget --once` render taken at the same time.
- A harness whose CLI is missing is a `skip`. A harness that is installed but whose launch or turn fails is a `fail`. Report it that way, even when the cause is upstream.
- A failure matching `KNOWN_GAPS` in the script is a `known-gap`. Every other failure is a `fail`.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then has exactly four H2 sections, in this order: `Sub-features`, `How to get to it (user POV)`, `Driving it with verify-oo`, and `Gotchas`. Keep implementation details out except the handles a check reads.

## Features

- [Harness turn](./harness-turn.md) covers a real delegated turn on each installed harness.
- [Session tracking](./session-tracking.md) covers the child session observed, finished, its reply readable, and its summary.
- [Widget](./widget.md) covers the child row while running and after finish, plus stuck Working rows among the owner's own sessions.
- [Search](./search.md) covers `oo search` discovery of each harness's reply.
- [Roles](./roles.md) covers orchestrator and worker instructions reaching the child's task message.

The script's `doctor` check is the Baseline's first precondition. Its `daemon-e2e` check (`--e2e`) runs the hermetic `npm run test:e2e` and appears only to track the known gap.
