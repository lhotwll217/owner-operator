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
  `OO_CURRENT_SESSION_ID`, and `oo runs delegate` records it as the run's parent, so completion
  delivery and the depth guard behave as they did for `delegate_agent`.
- The privacy guard exports `OO_AGENT=1`, and `oo` verbs then connect to the running daemon
  without starting or replacing one. An agent call must never restart the daemon that hosts it.
- Every permission mode writes allow rules for `oo` and `oo *` in the bash surface
  (`packages/core/src/permissions.mjs`). Owner bash rules come after them and the last match
  wins, so an owner rule can still narrow a verb. `read-only` is not a supported product mode:
  it denies bash, the permission extension then hides bash entirely, and the `oo` rules never
  apply.
- Guidance lives in `oo` help, nested by level, with examples on every verb. The system prompt
  embeds the generated root help rather than restating it, so the Operator and an outside agent
  read the same text, and what an eval proves for one holds for the other.
- `src/cli/conventions.test.ts` requires an `oo` verb for every agent-facing Gateway route. Its
  `PENDING` table lists the routes a native tool still covers; each retirement PR empties its
  rows, and the migration ends when the table is empty.
- Evals grade `oo` bash commands instead of native tool calls, as `eval/asserts/tool-use.mjs`
  already does for `oo search`. Schedules that store retired tool ids in `toolsAllow` are
  migrated when their family retires.
