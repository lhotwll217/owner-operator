# Harness turn

The owner hands work to a child agent on any installed harness through `oo runs delegate`, and the run finishes `completed` with the child's reply.

## Sub-features

- `installed` treats a harness CLI missing from `PATH` as a skip, not a failure.
- `launch` accepts the delegation and returns a pending run row.
- `reply` ends the run `completed` with the nonce in `resultTail` and a `childSessionId`.

## How to get to it (user POV)

- `oo runs delegate --harness <h> "<task>"` from a terminal (streams until finished).
- The same command from an agent's bash, or with `--no-wait`, returns the pending row.
- The Operator delegates on the owner's behalf from `oo` chat.

## Driving it with verify-oo

Preconditions:

- The harness CLI is on `PATH` and logged in.

- **Launch.** Run `oo runs delegate --harness codex --no-wait --json --timeout 300 --cwd $TMPDIR "This is an Owner Operator verification turn. Reply with exactly OOV_X_codex_plain and nothing else. Do not use tools."`. Exit 0 and a row with `status: pending`.
- **Finish.** Poll `oo runs get <id> --json` until `status` is terminal. Expect `status: completed`, `resultTail` containing the nonce, and `childSessionId` set.
- **Proof.** The script saves the final row to `run-<harness>.json`. The report row is `harness-turn / reply / <harness>`.

## Gotchas

- Model and effort resolve from the approved delegated baseline (`~/.owner-operator/delegated-baselines/`), else the harness's own choice. Under `OO_AGENT=1` a missing baseline refuses the launch, which is why the script unsets it.
- Cursor runs only Grok models.
- The installed runtime pins one commit. A harness upgrade can break it while a newer checkout works. On 2026-11-23 `oo harness details` on main rejected OpenCode 2.4.0 with "expected opencode v1". Run both targets before calling a failure a regression.
