# Vendored: session-grep

This directory is a vendored copy of the `skills/session-grep/` folder from the
standalone [session-grep](https://github.com/lhotwll217/session-grep) repo — the pure,
eval-tuned grep primitive. Owner Operator's agent-facing [`session-search`](../../../agent/skills/session-search/SKILL.md)
skill wraps it to inject its
own session sources and enforce the privacy blacklist.

- **Upstream:** https://github.com/lhotwll217/session-grep
- **Synced from:** `4bca8774bae94001e74a479ecbf58e34826ea7ad` @ `4bca8774bae94001e74a479ecbf58e34826ea7ad`

## Rules

- Do not edit the vendored copy directly. Primitive behavior belongs upstream; Owner
  Operator policy belongs in the shared [`session-search.mjs`](../../session-search.mjs) wrapper.
- The wrapper depends only on the stable seam: `--sources-file` / `SESSION_GREP_SOURCES_FILE`
  (typed roots), `--target-root`, `--target-type` / `--source`, `--exclude-session` (canonical
  session ID), `--exclude-re` (path blacklist), `--candidates`, scoped `--query` + `--session`,
  `--sort`, `--until`, anchored-window `--focus`, `--include-skill-bodies`, and `--json` output.
- Upstream's `SKILL.md` is omitted. Owner Operator exposes one product skill, not the generic
  upstream skill plus an opinionated duplicate. The upstream repository remains the source
  of truth for the shareable skill and primitive.

## Re-syncing an upstream release

```bash
node scripts/sync-session-grep.mjs --apply <ref>
```

Fetches upstream at `<ref>`, replaces this directory (omitting upstream's `SKILL.md`),
updates **Synced from** above, and runs the primitive's `--self-test`. Then run the
wrapper's integration test (`npm run test:integration`).

## Verifying This Copy

```bash
node scripts/sync-session-grep.mjs --check
```

Diffs this directory against the pinned commit. A zero exit proves the private dependency is
the recorded upstream runtime, with only `SKILL.md` deliberately omitted.
