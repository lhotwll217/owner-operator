---
name: updating-prompts
description: Ship the smallest delta to an existing prompt — fix a behavior, add a rule, or compress. Use when editing or reviewing system prompts, agent prompts, tool descriptions, or other LLM instructions.
---

A prompt change ships the smallest **delta** that holds — the least edit that still fixes the behavior.

## 1. Find the fork

Diagnose the exact decision the model gets wrong — the fork where it takes the wrong branch. Generalize from first principles: name the category of situations, then steer the category. A rule shaped like the latest failing example steers only that example and mis-steers its neighbors — one such phrase took a suite from 24/24 to 22/24.

```text
Overfit:  "When the user asks how many initiatives are in a program, exclude archived ones."
Fork:     "Archived items are excluded from counts and lists unless the user asks for them."
```

**Done when:** the fork reads "when X, the model does Y; it must do Z" — with X a category, not last week's case.

## 2. Choose the owning layer

Place the rule at the narrowest authoritative layer:

- **System prompt** — cross-tool policy, boundaries, routing.
- **Skill** — workflow and command mechanics.
- **Tool description / tool output** — tool-specific semantics, scoped metadata surfaced at call time.
- **Code** — invariants that must hold regardless of model compliance.

A rule the model already receives at another layer is a duplicate: leverage that layer instead of restating it.

**Done when:** the edit touches one layer, and that layer owns the behavior.

## 3. Write the smallest delta

- What/why pattern: what is the rule, why does it exist. Two sentences; a third only when needed; a fourth is an exception.
- State the positive target — the behavior to produce, with a prohibition only as a hard guardrail paired with what to do instead.
- When behavior went missing after a rewrite, mine git history for the wording that worked and restore the smallest sufficient piece, leaving surrounding text untouched.
- Durable text reads cold: stable policy only, free of thread residue — feedback given once is a candidate rule, and it earns permanence by recurring.

**Done when:** every sentence changes a decision, and the word delta against the base prompt is measured and reported.

## 4. Compress meaning-safe

Prompt wording is executable semantics. Trim no-ops — words removable with no behavior change. Triggers, scope nouns, and distinctions are where behavior lives: "challenge complexity", not "challenge it"; "when applying fixes to prompts", not "when changing prompts".

**Done when:** removing any remaining word would change behavior.

## 5. Validate the agent, then minimize

Validate the fix directionally on the failing case, then reduce the change until the fix still holds. Judge the whole agent — pass rate, total tokens, tool calls, latency. A smaller static prompt that buys extra discovery turns is a regression: one 14k→6k compression cost ~50% median latency.

**Done when:** the failing case passes, neighboring behavior is spot-checked, and the shipped delta is the smallest version that holds.
