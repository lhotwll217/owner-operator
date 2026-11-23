# Widget

The floating panel shows each session in its section. A delegated child is a smaller line under its parent while it works, and it leaves the panel once its run ends. The owner's own sessions move out of Working when their turn ends.

## Sub-features

- `child-row` shows a running child in Working, nested under its visible parent (`parentThreadId`, `depth >= 1`), and removes it after finish.
- `stale-working` flags, per transcript source, root rows still in Working with no message for 30 minutes and no live delegated child.
- `render` has the real widget binary render the current payload.

## How to get to it (user POV)

- The always-on macOS panel.
- `oo-widget --once`, which prints the panel's sections from the same `/session-state` payload.
- `oo session-state list`.

## Driving it with verify-oo

Preconditions:

- A built widget at the target's `apps/widget/.build/release/oo-widget`. A checkout never borrows the installed binary. Without its own build, `render` reports `skip`.
- `OO_HOME` set to the target daemon's home, because the widget finds its daemon through `$OO_HOME/daemon.json`.

- **Running child.** Launch the `widget` turn, which asks the child to run `python3 -c "import time; time.sleep(45)"` in the foreground before replying with the nonce. Poll `oo session-state list --json` every 3 seconds until the child id appears. Expect `section: working` and, with a visible parent, `parentThreadId` equal to the run's parent and `depth >= 1`.
- **Rendered.** Run `oo-widget --once` at that moment. The output contains the child row's `topic`. The script saves it as `widget-while-running.txt`.
- **After finish.** Once the run is terminal, `oo session-state list --json` no longer lists the child.
- **Stale working.** In the final `session-state list`, look for root rows in `working` whose `lastMessageAt` is over 30 minutes old and that are not the parent of a pending or running run. There should be none for any source.

## Gotchas

- Claude Code refuses a foreground `sleep` and backgrounds it, then ends the turn without the nonce. That is why the widget turn waits in Python.
- The child's transcript can settle a poll before its run turns terminal, so a running child may show Idle once. The check needs Working at least once, and title matching uses the title at render time, because enrichment retitles rows.
- A reply-only turn usually finishes before a scan admits its child. That is why only the `widget` turn has to be seen while running.
- The 30-minute stale threshold is the verifier's own choice, not a product rule. A genuinely long silent turn trips it. Open the transcript to confirm before filing.
- On 2026-11-23 the installed daemon showed Codex sessions in Working whose transcripts ended in `task_complete` hours earlier. That is the same symptom class as the OpenCode break.
