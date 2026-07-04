# Vendored: session-grep

This directory is a **verbatim copy** of the `skills/session-grep/` folder from the
standalone [session-grep](https://github.com/lhotwll217/session-grep) repo — the pure,
eval-tuned grep primitive. Owner Operator wraps it (see `../sessions-grep.mjs`) to inject
its own session sources and enforce the privacy blacklist; it does **not** fork it.

- **Upstream:** https://github.com/lhotwll217/session-grep
- **Synced from:** `main` @ `83c3b95d41ef55b6ac8e72ac1c9a69e5a0005fc4`

## Rules

- **Do not edit files in this directory.** Every Owner-Operator-specific behavior lives in
  the wrapper (`../sessions-grep.mjs`), never here, so this copy stays a swappable black box.
- The wrapper depends only on the stable seam: `SESSION_GREP_SOURCES_FILE` (typed roots),
  `--exclude-re` (path blacklist), `--json` output, and the `pi` adapter for oo's own threads.
- **Upstream's `SKILL.md` is stored as `SKILL.upstream.md`** (the one deliberate deviation
  from verbatim). A file named `SKILL.md` here could be discovered by a skill scanner as a
  second, unwrapped skill — one that searches default roots with NO blacklist and whose
  description carries none of oo's self-reflection triggers. The rename makes that
  impossible regardless of any loader's glob semantics; the primitive never reads its own
  SKILL.md at runtime, so nothing else changes.

## Re-syncing an upstream release

```bash
node .agents/skills/sessions-grep/sync-vendor.mjs --apply <ref>
```

Fetches upstream at `<ref>`, replaces this directory (applying the `SKILL.upstream.md`
rename), updates **Synced from** above, and runs the primitive's `--self-test`. Then run
the wrapper's integration test (`npx tsx harness/src/sessions-grep.integration.test.ts`):
the seam is stable, so a green run means the new version dropped in clean.

## Verifying this copy is verbatim

```bash
node .agents/skills/sessions-grep/sync-vendor.mjs --check
```

Diffs this directory against the pinned commit and fails on any drift — the "do not edit"
rule above, enforced mechanically. Run it after anything touches `vendor/` (and in CI once
the repo grows one).
