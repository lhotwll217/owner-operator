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
- **Concise.** High-signal, low-noise — in the product, the docs, and your output.
