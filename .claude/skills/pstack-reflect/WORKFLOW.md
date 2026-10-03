Read [pstack portability and capability checks](../pstack/README.md) before following this workflow. Owner and harness policy governs every step.

# Reflect

Mine the current conversation for durable learnings, then route them into skill edits.

## When to invoke

Invoke when the user says "reflect" or "/pstack-reflect". Skip when the conversation is trivial, off-topic, or already covered by an existing skill the parent followed correctly. One-offs are not learnings.

## Process

### 1. Locate the active transcript

Resolve the current session’s stable ID using the host’s session context. Retrieve bounded evidence through the approved privacy-aware session-search route, including tools when checking actions. If the current session is excluded or unavailable, use a clearly labeled digest of this conversation rather than bypassing the policy. Pass that evidence or digest to reviewers.

### 2. Spawn three reviewers in parallel

One message, three calls through the supported delegation API, a general-purpose worker role, explicit `model:` on each, read-only investigation using available tools. Preserve the harness permission mode.

| Lens | `model` | Prompt template |
|---|---|---|
| Judgment | your configured reflect-judgment model (selected through owner policy) | `references/judgment-reviewer.md` |
| Tooling | your configured reflect-tooling model (selected through owner policy) | `references/tooling-reviewer.md` |
| Divergent | your configured reflect-judgment model (selected through owner policy) | `references/divergent-reviewer.md` |

Pass each template verbatim, substituting the transcript path or digest where marked. Reviewers return findings in the the supported delegation API response body.

### 3. Synthesize

One call through the supported delegation API, a general-purpose worker role, using your configured reflect-judgment model (selected through owner policy), read-only investigation using available tools. Preserve the harness permission mode.

### 4. Structural enforcement check

Sanity-check the synthesizer's Accepted list. For any item that would be enforced more reliably by a lint rule, script, metadata flag, or runtime check, move it from Accepted to Backlog. See the [pstack-principle-encode-lessons-in-structure](../pstack-principle-encode-lessons-in-structure/WORKFLOW.md) principle skill.

### 5. Apply

Before applying any Accepted edit, present the synthesizer's full Accepted/Rejected/Backlog output to the user and wait for explicit approval. The user picks which subset to apply and may redirect routings. Skill changes affect every future agent in the org. Do not auto-apply.

Keep backlog proposals in the response unless tracker writes are authorized. Accepted edits follow the owner’s approval policy.

For each approved Accepted item, follow the Routing field exactly:

- Trivial existing-skill edit (a one-line bullet, a tightened sentence, a stale fact corrected): parent does directly.
- Substantive existing-skill edit (a new section, a new pattern table, more than ~10 lines): hand to the skill-authoring guidance resolved in the portability entry point and run its draft / test / iterate loop.
- `tune description: <skill path>` (the skill exists but didn't trigger when it should have): hand to the resolved skill-authoring guidance and run its description-optimization loop.
- `new skill via create-skill: <kebab-name>`: hand creation to the resolved skill-authoring guidance. Do not invent the shape ad hoc.

If your environment ships a SKILL.md validator, run it on every touched skill before declaring done. Skip this step if it doesn't.

### 6. Summarize for the user

Short list, no preamble:

- Edits applied: `<skill path>`. What changed, one line each.
- New skills created: `<skill path>`. One line each (rare).
- Backlog filed to the devex tracker: `<issue title>` (`<tags>`). One line each.
- Dropped: one line per rejected finding + reason from the synthesizer.
