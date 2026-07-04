# Owner Operator — Development

## Orient first

Read these before writing code — don't re-derive intent from the source:

- **[README.md](README.md)** — what we're building, repo layout, current status.
- **[docs/architecture.md](docs/architecture.md)** — the shape and component boundaries.

## Development conventions

- **Monorepo.** `harness/` (the pi-based core), `apps/` (widget, web), `packages/` (core
  types, workflows). Keep shared types in `packages/core/` so surfaces and harness speak one
  language.
- **Match the surrounding code** — its naming, comment density, and idioms.
- **Don't reinvent the wheel.** Prefer battle-tested patterns from maintained open source —
  start from [docs/inspiration.md](docs/inspiration.md); look for prior art beyond it when needed.
- **Issues preferred, links always.** An issue first for non-trivial work; PRs link theirs
  when one exists. Workflow and checks: [CONTRIBUTING.md](CONTRIBUTING.md).
- **Single-source docs.** Say a thing in one file and hyperlink to it from the others —
  duplicated docs drift.
- **Concise.** High-signal, low-noise — in the product, the docs, and your output.
