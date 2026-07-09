---
name: gh-search
description: >-
  Search GitHub from the terminal with `gh search` (repos, code, issues, prs) to find real-world
  code examples. Use when the user wants to see how an established project implements
  something, find a maintained example to borrow from, or check a repo's stars/contributors/activity
  before trusting its code — and when another skill needs vetted examples.
---

# gh-search

`gh search` finds code and repositories across GitHub from the terminal. Pick the subcommand that
matches the question; add `--json` + `--jq` to keep output small.

## Searching

```sh
# Repos, by adoption
gh search repos <keywords> stars:>500 language:go archived:false --sort=stars \
  --json fullName,stargazersCount,pushedAt,description --jq '.[]|"\(.stargazersCount)\t\(.fullName)"'

# The implementing file (not the README)
gh search code "sqlite3_update_hook language:go" --json repository,path,url

# How an error was fixed / an API was designed
gh search issues "<error text>" --state=closed
gh search prs "<feature>" --state=merged
```

Qualifiers go in the query string: `stars:>N`, `pushed:>YYYY-MM-DD`, `language:X`, `topic:X`,
`org:X`, `archived:false`, `in:name,description,readme`. Code search reads the default branch only
and needs auth.

## Stats gh search omits

`gh search` returns stars and forks. Before copying code, pull the numbers it leaves out — they
separate a maintained project from an abandoned one:

```sh
gh api repos/OWNER/REPO --jq '{stars:.stargazers_count, forks:.forks_count, pushed:.pushed_at, archived:.archived}'
gh api "search/issues?q=repo:OWNER/REPO+type:pr"    --jq .total_count   # PRs (openIssuesCount mixes both)
gh api "search/issues?q=repo:OWNER/REPO+type:issue" --jq .total_count   # issues
gh api "repos/OWNER/REPO/contributors?per_page=1&anon=1" -i | grep -i '^link:'   # last page number = contributor count
```

## Rules

- Show a repo's stats before treating its code as a dependable example.
- Popular ≠ correct — read the code you copy.
- Cite the repo and file you copy from.
