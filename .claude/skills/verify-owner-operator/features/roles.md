# Roles

`oo runs delegate --role orchestrator|worker` appends the owner's instructions file for that role, then a delegation boundary, to the child's task message. A plain run gets the task alone.

## Sub-features

- `role-file` confirms the role's instructions file exists and is non-empty in the target's `$OO_HOME/workspace/`.
- `delivered` shows the child's first user message holding the whole instructions file (whitespace collapsed) and the role boundary. For a worker that is "Complete the work directly; do not launch further agents." For an orchestrator it is `oo runs delegate --from-session <its own child session id>`.

## How to get to it (user POV)

- `oo runs delegate --role worker "<task>"` or `--role orchestrator`.
- The Operator choosing a role when it delegates.

## Driving it with verify-oo

Preconditions:

- `delegated-worker-instructions.md` and `delegated-child-instructions.md` exist in `$OO_HOME/workspace/`.

- **Launch.** Run `oo runs delegate --harness claude-code --role worker --no-wait --json --cwd $TMPDIR "<reply-with-nonce task>"`, then the same with `--role orchestrator`.
- **Delivered.** After the run, run `oo search --session <child> --query <nonce> --role user --json --max-chars 20000`. The user message contains the whole instructions file and the boundary text. The script saves it as `prompt-<harness>+<role>.txt`.

## Gotchas

- When the role harness is not installed or is outside `--harness`, both role checks report `skip`. Pass `--role-harness` to run them elsewhere.

- Known gap `role-file-silent`: a missing or whitespace-only role file adds nothing, and nothing warns. The owner's worker file was once missing unnoticed. `role-file` is the check that catches it.
- The files are reread for every task message, so an edit applies to the next run.
- An orchestrator boundary that says "No child session identity was confirmed" means the launcher lost the child id, and the child cannot delegate.
