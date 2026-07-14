# Owner Operator — Development

This file owns policy. Skills own workflows. Behavior knowledge lives in
[docs/](docs/): run `npm run docs:list`, then read the relevant pages before
working on a surface. Read a subtree's `AGENTS.md` before working in it.

- **Be concise.** High signal, low noise, always. Digestible information promotes
  decision-making.
- **Cite causal claims granularly.** Hand-waved conclusions are dangerous, and
  the reader will ask for sources anyway.
- **Don't reinvent.** Proven, maintained open source beats local code. Start at
  [docs/inspiration.md](docs/inspiration.md), then search (gh-search skill);
  cite what you keep to pinned lines (`…/blob/<SHA>/path#L10-L40`).
- **Documentation lives in one place.** Pointers survive change; restated
  behavior silently goes stale.
- **Complexity must earn its keep.** It's almost always better to build up than
  tear down. Challenge complexity.
- **Durable text must make sense without prior context.** Docs, comments, and
  prompts outlive the conversation that produced them; reread as a stranger
  before saving.
