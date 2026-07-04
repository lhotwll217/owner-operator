# Contributing

Orient first: [README](README.md) → [docs/architecture.md](docs/architecture.md) →
[docs/testing.md](docs/testing.md). Conventions live in [AGENTS.md](AGENTS.md) — they apply
to humans and agents alike.

## Workflow

1. **Issue first (preferred).** Non-trivial work starts as an issue: problem first — who
   hits it and what happens today — then scope. The forms in `.github/ISSUE_TEMPLATE/`
   enforce the shape. Small, self-evident fixes can go straight to a PR.
2. **Branch → PR → link the issue.** Branch from `main`; the PR follows the template
   (problem → what changed → verification) and carries `Closes #N` when an issue exists,
   so the trail from problem to landing is one click.
3. **Green before review.** Run the checks below locally; CI runs the same set on every PR
   and again on every landing on `main`.

## Checks

| Check | Command | CI |
|---|---|---|
| Types | `npm run typecheck` | `ci.yml` |
| Lint ([oxlint](https://oxc.rs/docs/guide/usage/linter)) | `npm run lint` | `ci.yml` |
| Hermetic tests (unit · integration · e2e) | `npm test` | `ci.yml` |
| Widget (Swift) | `cd apps/widget && swift test` | `widget.yml` (macOS, path-filtered) |

`npm test` is hermetic; the `smoke`/`live` tiers are manual and stay out of CI by design —
the tier taxonomy and hermetic rule live in [docs/testing.md](docs/testing.md).

## Standards

- **Don't reinvent the wheel** — the canonical rule and its pattern sources live in
  [AGENTS.md](AGENTS.md) and [docs/inspiration.md](docs/inspiration.md).
- **Dependencies.** pi (`@earendil-works/pi-*`) is consumed as npm deps — pinned exact while
  pre-1.0, never forked. The widget takes no external deps (system frameworks only).
- **Vendored code** (`.agents/skills/*/vendor/`) is upstream-owned: never hand-edit it.
  Re-sync per the directory's `UPSTREAM.md` and update the pin there. Vendor dirs are
  excluded from lint.
- **Shared types** live in `packages/core` so the harness and every surface speak one language.
