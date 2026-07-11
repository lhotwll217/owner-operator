# Vendored: session-grep

This directory is a vendored copy of the `skills/session-grep/` folder from the
standalone [session-grep](https://github.com/lhotwll217/session-grep) repo — the pure,
eval-tuned grep primitive. Owner Operator's agent-facing [`session-search`](../../SKILL.md)
skill wraps it to inject its
own session sources and enforce the privacy blacklist.

- **Upstream:** https://github.com/lhotwll217/session-grep
- **Synced from:** `main` @ `a4e1b591fd367c94c136b381b85574a0a1d1e58a`

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

### Pending upstream delta

- Canonical Codex UUIDs now resolve `rollout-<timestamp>-<uuid>.jsonl` for `--skim` and
  `--session`; short skims are lossless within `--max-chars`, and pointer drill-in spends
  its aperture on the selected message and retains that target even under a tight context
  budget. Canonical `--exclude-session` and pre-limit,
  pre-budget `--candidates` grouping are included in the same local delta. So are hard rendered
  skim budgets, scoped in-session queries with omission feedback, and fail-closed ambiguous
  modes. `--any` also normalizes pipe-separated terms, and query previews now spend the global
  aperture on complete short messages instead of treating 300 characters as a ceiling. A
  common leading `(?i)` regex modifier is normalized before both prefiltering and matching, and
  literal queries beginning with dashes are protected from both wrapper and ripgrep option parsing.
  The changes and regression tests live in the adjacent local `session-grep` checkout;
  remove this note after that change is published and the vendor is re-synced to its upstream
  commit. Until then, `scripts/sync-session-grep.mjs --check` is expected to report drift from
  the recorded pin; Owner Operator's integration tier runs the vendored primitive's `--self-test`
  so the documented local delta remains executable in CI.

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
the recorded upstream runtime, with only `SKILL.md` deliberately omitted. While a **Pending
upstream delta** is documented above, a non-zero drift result is intentional; verify that the
vendor remains byte-identical to the adjacent `session-grep` working tree and that
`npm run test:integration` passes. Publish upstream and re-sync promptly so the recorded pin
becomes authoritative again.
