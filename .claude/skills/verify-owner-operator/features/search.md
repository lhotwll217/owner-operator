# Search

`oo search` finds what any harness session said, so the owner and the Operator can ask "where did X happen" across every store.

## Sub-features

- `search` has discovery (`--query` with no `--session`) return the child session's assistant message containing the nonce.

## How to get to it (user POV)

- `oo search --query <text>` from a terminal or an agent.
- The Operator's transcript search from `oo` chat.

## Driving it with verify-oo

Preconditions:

- A completed plain harness turn and its nonce.

- **Discover.** Run `oo search --query <nonce> --json --limit 20`. Retry every 5 seconds for up to 90 seconds while the index catches up. `matches` holds an entry with the child's `id` and `match.role: assistant`.
- **Proof.** The report row lists the backend that answered (`agentsview` or `session-grep`) and every matching `id:role`.

## Gotchas

- Discovery runs on agentsview whenever its daemon is up and only falls back to session-grep when it is down. An agentsview indexing gap therefore reads as a search failure.
- Known gap `agentsview-opencode`: agentsview v0.48.0 cannot find OpenCode 2.4 replies.
- Discovery excludes the calling Operator session and its immediate caller, never the children.
