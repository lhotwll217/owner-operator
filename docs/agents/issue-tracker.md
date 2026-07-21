---
title: "Issue tracker"
summary: "GitHub issue operations used by engineering, triage, specification, and wayfinding skills"
read_when:
  - Reading, creating, updating, or closing an engineering issue
  - Publishing a specification or tickets
  - Running triage or wayfinding
---

# Issue tracker: GitHub

Issues and PRDs for this repository live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue:** `gh issue create --title "..." --body "..."`. Use a heredoc or body file for multi-line content.
- **Read an issue:** `gh issue view <number> --comments`, including labels.
- **List issues:** `gh issue list --state open --json number,title,body,labels,comments`, narrowed with appropriate state and label filters.
- **Comment:** `gh issue comment <number> --body "..."`.
- **Apply or remove labels:** `gh issue edit <number> --add-label "..."` or `--remove-label "..."`.
- **Close:** `gh issue close <number> --comment "..."`.

Infer the repository from `git remote -v`; `gh` does this automatically inside the clone.

## Pull requests as a triage surface

**PRs as a request surface: no.**

GitHub shares one number space across issues and pull requests. Resolve a bare `#42` with `gh pr view 42`, then fall back to `gh issue view 42`.

## Skill vocabulary

When a skill says **publish to the issue tracker**, create or update the relevant GitHub issue.

When a skill says **fetch the relevant ticket**, run `gh issue view <number> --comments`.

## Wayfinding operations

The wayfinder's **map** is one issue with child issues as tickets.

- **Map:** an issue labelled `wayfinder:map`, containing Notes, Decisions-so-far, and Fog.
- **Child ticket:** a GitHub sub-issue. If sub-issues are unavailable, link it from the map task list and put `Part of #<map>` in the child body.
- **Child labels:** `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, or `wayfinder:task`.
- **Blocking:** use GitHub's native issue dependencies. Post the blocker's numeric database ID—not issue number—to `repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by`.
- **Frontier:** choose the first open, unassigned map child with no open blocker.
- **Claim:** `gh issue edit <number> --add-assignee @me`; this is the session's first write.
- **Resolve:** comment with the answer, close the child, and add its durable context pointer to the map's Decisions-so-far.
