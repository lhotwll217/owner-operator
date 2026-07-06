# Owner Operator — Development

## Orient first

Read these before writing code — they carry the intent:

- **[README.md](README.md)** — what we're building, repo layout, current status.
- **[docs/architecture.md](docs/architecture.md)** — the shape and component boundaries.

## Development conventions

- **Monorepo.** `packages/gateway/` is the state-owning local gateway; `harness/` is the
  pi-based agent/terminal client; `apps/` holds widget/web; `packages/core/` holds shared
  types so every surface speaks one language.
- **Match the surrounding code** — its naming, comment density, and idioms.
- **Prior art first.** Battle-tested patterns from maintained open source — start at
  [docs/inspiration.md](docs/inspiration.md); hunt further when it comes up short.
- **Issues preferred, links always.** An issue first for non-trivial work; PRs link theirs
  when one exists. Workflow and checks: [CONTRIBUTING.md](CONTRIBUTING.md).
- **Single-source docs.** Say a thing in one file and hyperlink to it from the others —
  duplicated docs drift.
- **Concise.** High-signal, low-noise — in the product, the docs, and your output.
