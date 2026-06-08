# Owner Operator — Development

## Orient first

Read these before writing code — don't re-derive intent from the source:

- **[VISION.md](VISION.md)** — what we're building and why.
- **[docs/architecture.md](docs/architecture.md)** — the shape and component boundaries.
- **[README.md](README.md)** — repo layout and current status.

## Inspiration

Don't reinvent the wheel — check [`docs/inspiration.md`](docs/inspiration.md) for existing
tools we can learn from before building anything non-trivial, and add to it when you find
something worth leaning on.

## Development conventions

- **Monorepo.** `harness/` (the pi-based core), `apps/` (widget, web), `packages/` (core
  types, workflows). Keep shared types in `packages/core/` so surfaces and harness speak one
  language.
- **Match the surrounding code** — its naming, comment density, and idioms.
- **Concise.** High-signal, low-noise — in the product, the docs, and your output.
