# Vendored: session-grep

This directory is a vendored copy of the `skills/session-grep/` folder from the
standalone [session-grep](https://github.com/lhotwll217/session-grep) repo — the pure,
eval-tuned grep primitive. Owner Operator wraps it (see `../../src/session-search/sessions-grep.mjs`) to inject
its own session sources and enforce the privacy blacklist.

- **Upstream:** https://github.com/lhotwll217/session-grep
- **Synced from:** `main` @ `83c3b95d41ef55b6ac8e72ac1c9a69e5a0005fc4`
- **Local delta:** `--sources-file`, `--target-root`, and `--target-type` pending upstream issue
  [#5](https://github.com/lhotwll217/session-grep/issues/5).

## Rules

- Keep local primitive edits small and upstreamable. Owner-Operator-specific behavior still
  belongs in the wrapper (`../../src/session-search/sessions-grep.mjs`); primitive behavior belongs upstream.
- The wrapper depends only on the stable seam: `--sources-file` / `SESSION_GREP_SOURCES_FILE`
  (typed roots), `--target-root`, `--target-type`, `--exclude-re` (path blacklist), and
  `--json` output.
- **Upstream's `SKILL.md` is stored as `SKILL.upstream.md`** (the one deliberate deviation
  from verbatim). A file named `SKILL.md` here could be discovered by a skill scanner as a
  second, unwrapped skill — one that searches default roots with NO blacklist and without
  Owner Operator's source/blacklist guidance. The rename makes that
  impossible regardless of any loader's glob semantics; the primitive never reads its own
  SKILL.md at runtime, so nothing else changes.

## Re-syncing an upstream release

```bash
node scripts/sync-session-grep.mjs --apply <ref>
```

Fetches upstream at `<ref>`, replaces this directory (applying the `SKILL.upstream.md`
rename), updates **Synced from** above, and runs the primitive's `--self-test`. Reapply or
drop the local delta depending on upstream issue #5, then run the wrapper's integration
test (`npm run test:integration`).

## Verifying This Copy

```bash
node scripts/sync-session-grep.mjs --check
```

Diffs this directory against the pinned commit and fails while the local delta is present.
Use it after upstream issue #5 lands to confirm the delta has been absorbed and the vendor
copy is back to the pinned upstream content.
