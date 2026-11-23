# Session tracking

Owner Operator observes the child's transcript as a session thread, sees the turn finish, reads the reply, and writes a status summary.

## Sub-features

- `observed` gives the child session a `threads` row under the harness's transcript format (`claude`, `codex`, `cursor`, `opencode`, `antigravity`).
- `finished` leaves the latest `thread_details` state off `working` once the run ends.
- `reply` has the transcript reader return the assistant message containing the nonce.
- `summary` gives the thread a `written_by='model'` status summary.

## How to get to it (user POV)

- The widget row's title, state, and summary.
- `oo session-state list` and `oo db query` over `threads` and `thread_details`.
- `oo search --session <id>` and `--skim <id>`.

## Driving it with verify-oo

Preconditions:

- A completed harness turn with its `childSessionId`.

- **Observed.** Run `oo db query "select id, source, app, transcript_path from threads where id = '<child>'" --json`. One row whose `source` matches the harness.
- **Finished.** Run `oo db query "select version, written_by, state from thread_details where thread_id = '<child>' order by version desc limit 1" --json`. `state` is `idle` or `needs-you` within 120 seconds. `working` after the run ended means the reader missed the reply.
- **Reply.** Run `oo search --session <child> --query <nonce> --role assistant --json`. A match whose role is `assistant`.
- **Summary.** Run `oo db query "select status_summary from thread_details where thread_id = '<child>' and written_by = 'model' and status_summary is not null order by version desc limit 1" --json`. One non-null row within 60 seconds.

## Gotchas

- Known gap `child-summary`: a finished delegated child projects as done, and enrichment skips done rows, so `summary` fails for every harness today.
- Known gap `summary-1200`: summaries see only the first 1,200 characters of a reply for sources other than Claude, Codex, and Pi (`AGENT_STATE_RESULT_MAX_LENGTH`). No delegated child gets a summary, so this cannot be observed live yet.
- `session-state list` omits done rows, so a finished child is absent there by design. Read tracking from the database.
