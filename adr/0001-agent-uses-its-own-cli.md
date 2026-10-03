---
title: "ADR 0001: The Operator uses its own CLI"
summary: "Decision record: the Operator reaches Owner Operator through `oo` from bash, and a native tool exists only when a UI renders its result"
read_when:
  - Deciding whether a capability becomes an Operator tool or an `oo` verb
  - Changing how the Operator's bash reaches `oo` (PATH, environment, permissions, daemon connection)
  - Retiring a native tool in favor of an `oo` verb
---

# The Operator uses its own CLI; tools exist only when a UI renders the result

The Operator reaches every Owner Operator capability through the `oo` CLI from bash, the same
surface the owner and outside coding agents use. The harness defines a native tool only when a UI
renders that call's result. Today no tool qualifies: every custom tool renders through the
generic tool display (`src/agent/tool-display.ts`), so each is a duplicate of an `oo` verb.

Issue #116 (PR #166) put native tools and `oo` verbs side by side over the same Gateway routes.
Stitcher adopted that pattern and then reversed it in its own ADR 0001 after hand-picked tools
drifted from what the product could do: its agent miscounted saved words because no tool
reached the store that held them. With one surface, a capability missing from the Operator is
missing from `oo`, where anyone can see it. This ADR makes the same reversal here.

## Consequences

- Tool families retire one pull request at a time: session state, database, schedules, delegated
  runs, harness details and baselines, worktrees. Each PR adds the missing verb or flag, moves
  the prompt, skills, and evals onto `oo` commands, and deletes the tool. `use_worktree` moves
  too, so the interactive runtime learns of a worktree change without a tool result.
- The Operator's bash identifies its own session: the privacy guard exports
  `OO_CURRENT_SESSION_ID`, and `oo runs delegate` records it as the run's parent ahead of any
  `--from-session` the model passes. This stops accidental misattribution, not deliberate
  spoofing: the model controls its own command's environment, and the daemon trusts the parent id
  the CLI sends. `delegate_agent` reads the session from Pi, so it stays the only unforgeable path
  until the delegated-runs PR binds the parent to a per-session credential the daemon verifies.
- The privacy guard exports `OO_AGENT=1`. `oo` verbs then connect to the running daemon without
  starting or replacing one, and the forms that would start a daemon or a nested Operator
  (`oo`, `oo -p`, `oo --continue`, `oo --session`, `oo daemon`) refuse to run. An agent call must
  never restart the daemon that hosts it.
- Every permission mode writes allow rules for `oo` and `oo *` in the bash surface
  (`packages/core/src/permissions.mjs`). Owner bash rules come after them and the last match
  wins, so an owner rule can still narrow a verb. `read-only` is not a supported product mode:
  it denies bash, the permission extension then hides bash entirely, and the `oo` rules never
  apply. Allowing `oo` in `ask` mode also lets headless runs, which cannot answer an approval,
  create, run, and delegate through `oo` where the matching native tool would ask; a command
  schedule can run any program. This is deliberate: native tools and `oo` verbs are product
  actions the Operator may take without approval.
- Guidance lives in `oo` help, nested by level, with examples on every verb. The system prompt
  embeds the generated root help rather than restating it, so the Operator and an outside agent
  read the same text, and what an eval proves for one holds for the other.
- `src/cli/conventions.test.ts` requires an `oo` verb for every agent-facing Gateway route. Its
  `PENDING` table lists the routes a native tool still covers, and each retirement PR empties its
  rows. A tool with no route (`manage_delegated_baseline` runs in-process) gains one when its
  family retires. The migration ends when `createOwnerOperatorCustomTools` returns no tools.
- Evals grade `oo` bash commands instead of native tool calls, as `eval/asserts/tool-use.mjs`
  already does for `oo search`. Schedules that store retired tool ids in `toolsAllow` are
  migrated when their family retires.
