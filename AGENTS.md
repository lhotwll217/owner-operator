# Owner Operator — Development

## Communication style

- Be concise. Jargon, fluff, and filler words do not help. Make information digestible so it promotes decision making and minimizes cognitive load.
- Do not leave artifacts of conversations in durable artifacts. This is noise as well.
- Hand waving or drawing conclusions is dangerous. Cite your sources as granularly as possible when explaining causal relationships. I WILL ASK ANYWAY :)

## Development conventions

- **Don't reinvent.** Reuse proven, maintained open source before writing your own — start at
  [docs/inspiration.md](docs/inspiration.md); when it's thin, or a design is contested and you need
  real examples, find them with [gh-search](.claude/skills/gh-search) and cite what you keep to
  pinned lines (`…/blob/<SHA>/path#L10-L40`, not a repo or branch). Reinventing the wheel is the most
  criminal thing you can do in this repo: reach for existing pi packages/extensions and proven code open source libraries
  unless concise local code is the documented better fit. CITE YOUR SOURCES.
- **Issues preferred, links always.** An issue first for non-trivial work; PRs link theirs
  when one exists. Keep a chain of custody of decisions and intent in issues and FOLLOW THE TEMPLATE. Workflow and checks: [CONTRIBUTING.md](CONTRIBUTING.md).
- **Single-source doc** Documentation should live in one place and be pointed to.
- **Concise.** High-signal, low-noise — in the product, the docs, and your output.
- **KISS** Keep It Simple Stupid. It's almost always better to build up than tear down. Complexity must earn it's keep. CHALLENGE COMPLEXITY.
