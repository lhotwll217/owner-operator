---
name: verify-owner-operator
description: Live-verify Owner Operator on this Mac by driving `oo` through real harness turns and reporting pass/fail with evidence per feature. Use to prove an oo change works for real before a PR, after installing a runtime, or when asked whether oo still works.
---

# Verify Owner Operator

The feature map in [features/README.md](features/README.md) is the source for what each check proves and how to drive it by hand.

## Launch

Pick the target:

- **installed** (default) drives the global `oo` and the owner's daemon (`$HOME/.owner-operator`). This is what the owner and the widget see.
- **checkout** starts an isolated daemon from a repo checkout. Use it to verify a branch before it is installed. It runs `<repo>/oo daemon` with a temp `OO_HOME`, a free `OO_PORT`, and the real `HOME`, so harness logins and transcript stores are the owner's. It copies the owner's onboarding, transcript sources, `pi/` model credentials, delegated baselines, and role files into the temp home, and sets `activeWindow` to `1h` so enrichment only summarizes recent sessions. launchd manages only the default `OO_HOME` (`launchdCanManageCurrentHome` in `src/daemon/ensure.ts`), so this daemon can never restart the owner's.

```sh
node .claude/skills/verify-owner-operator/scripts/verify-oo.mjs                       # installed
node .claude/skills/verify-owner-operator/scripts/verify-oo.mjs --target checkout --repo <path>
node .claude/skills/verify-owner-operator/scripts/verify-oo.mjs --help                # every flag
```

A full run takes 3 to 6 minutes and spends one short model turn per harness, plus three on the role harness. The script strips `OO_AGENT` and `OO_AGENT_RUN_LEASE_ID`, as the owner's earlier manual live checks did. That way an agent caller still gets the harness default when no baseline is approved. Runs launched from an agent session nest under that session in the widget.

A checkout daemon can take up to 5 minutes to answer `/health`, because `./oo` first runs `npm ci` when `node_modules` is stale.

## Doctor

The script's first check, also the one to run by hand when anything looks off:

```sh
oo doctor                      # Status: ready, Install root
curl -s -H "authorization: Bearer $(jq -r .authToken ~/.owner-operator/daemon.json)" \
  http://127.0.0.1:$(jq -r .port ~/.owner-operator/daemon.json)/health   # repoRoot, stale
```

The instance is worth driving when the doctor says `ready`, `/health` reports `stale: false`, and its `repoRoot` is the target: the installed runtime (`realpath $(which oo)`'s directory) or the checkout. For a checkout target, use the same commands with `OO_HOME` set to the temp home the report names. When the doctor fails, the script stops before launching any turn.

## Evidence

Everything lands in the evidence directory and survives cleanup:

- `report.md` and `report.json` hold one row per check with its verdict and evidence.
- `doctor.txt` and `health.json` record the instance identity.
- `run-<harness>[+kind].json` holds each run's ledger row.
- `timeline.json` has a run status and child-row poll every 3 seconds, which is the widget's input.
- `widget-while-running.txt` and `widget.txt` are real `oo-widget --once` renders.
- `session-state.json` is the final `/session-state`.
- `prompt-<harness>+<role>.txt` is the task message the role child actually received.
- The checkout target also writes `daemon.log` and `cleanup.json`. `--e2e` adds `e2e.log`.

Verdicts are `pass`, `fail`, `skip`, and `known-gap`. A `skip` means a harness CLI, the role harness, or the target's built widget is missing. A known gap is a failing check that matches `KNOWN_GAPS` in the script, including its evidence pattern when it has one, the breakage the owner already knows about. When a known gap's check passes, the report says it was not reproduced. Check whether it was fixed, and if so, delete its entry. The script exits 1 on any `fail`.

Proof standards:

- Every turn goes through `oo runs delegate`, the owner's path. Headless native CLIs are not used: `claude -p` is an automated transport and never becomes a session row (`session-hosts.mjs`).
- Tracking is read from the state database (`oo db query`) and the transcript reader (`oo search --session`), never from the run's own result alone.
- Widget proof is `/session-state` plus the real widget binary's render. The binary renders the same payload the panel does.
- Report a fail exactly as observed. Weakening a check so it passes hides the next break that only shows up live.

## Cleanup

- **installed.** Runs that outlive `--timeout + 120s` are cancelled by ID. Finished delegated children project as done and leave the widget on their own. Nothing else was created.
- **checkout.** The script sends SIGTERM to the daemon PID it spawned and to any replacement named in the temp home's `daemon.json` that holds that home's `state.db` open (SIGKILL after 20 seconds). It records leftover process leases and processes with files open under the temp `OO_HOME` in `cleanup.json`, then deletes the temp home, including the copied credentials. A non-empty `processesLeft` names PIDs the run started: kill those PIDs, never by process name.

SIGINT, SIGTERM, and SIGHUP run the same cleanup and still write the report. If the script is killed outright, each `oo-verify-*` directory under `$TMPDIR` is a stranded home. Read its daemon's PID from `<dir>/oo-home/daemon.json`. Kill it only when `lsof -a -p <pid> -Fn` lists `<dir>/oo-home/state.db`, because after a reboot the PID can belong to another process. Then delete the directory. Cleanup is done when no `oo-verify-*` directory remains.
