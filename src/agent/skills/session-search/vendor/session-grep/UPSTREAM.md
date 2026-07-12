# Vendored: session-grep

This directory is a vendored copy of the `skills/session-grep/` folder from the
standalone [session-grep](https://github.com/lhotwll217/session-grep) repo — the pure,
eval-tuned grep primitive. Owner Operator's agent-facing [`session-search`](../../SKILL.md)
skill wraps it to inject its
own session sources and enforce the privacy blacklist.

- **Upstream:** https://github.com/lhotwll217/session-grep
- **Synced from:** `agent/publish-session-retrieval-primitives` @ `05bd4c347be49bd47f63e755f63c3bdcb1332aa9`

## Rules

- Do not edit the vendored copy directly. Primitive behavior belongs upstream; Owner
  Operator policy belongs in the skill's [`scripts/session-search.mjs`](../../scripts/session-search.mjs) wrapper.
- The wrapper depends only on the stable seam: `--sources-file` / `SESSION_GREP_SOURCES_FILE`
  (typed roots), `--target-root`, `--target-type` / `--source`, `--exclude-session` (canonical
  session ID), `--exclude-re` (path blacklist), `--candidates`, scoped `--query` + `--session`,
  `--sort`, and `--json` output.
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
