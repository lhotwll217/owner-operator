# Docs

This folder is the single home for behavior knowledge. Code, README, and prompts
point here; they do not restate.

- **Every page starts with routing frontmatter.** `title`, a one-line `summary`,
  and `read_when` triggers let a reader or agent pick the right page without
  reading bodies.
- **One page per surface.** A page owns its surface's behavior; overlapping
  content merges or points.
- **Point at in-code contracts instead of restating them.** Catalogs, schema
  docs, and flag parsers document themselves; pages link to them.
- **Write only the current contract.** Before saving, ask: what context am I
  assuming, what code change would falsify this silently, and where else have I
  already said this?
