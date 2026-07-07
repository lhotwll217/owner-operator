# Owner Operator — Development

## Orient first

Read these before writing code — they carry the intent:

- **[README.md](README.md)** — what we're building and current status.
- **[docs/architecture.md](docs/architecture.md)** — repo layout, shape, and component boundaries.

## Development conventions

- **Architecture source of truth.** Keep repo layout and component-boundary details in
  [docs/architecture.md](docs/architecture.md). Other docs, especially the README, should
  link there instead of duplicating layout.
- **Match the surrounding code** — its naming, comment density, and idioms.
- **Prior art first.** Battle-tested patterns from maintained open source — start at
  [docs/inspiration.md](docs/inspiration.md); hunt further when it comes up short.
- **Issues preferred, links always.** An issue first for non-trivial work; PRs link theirs
  when one exists. Workflow and checks: [CONTRIBUTING.md](CONTRIBUTING.md).
- **Single-source docs.** Say a thing in one file and hyperlink to it from the others —
  duplicated docs drift. If the layout changes, update `docs/architecture.md` first.
- **Concise.** High-signal, low-noise — in the product, the docs, and your output.
