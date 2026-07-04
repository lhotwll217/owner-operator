# Vendored: session-grep

This directory is a **verbatim copy** of the `skills/session-grep/` folder from the
standalone [session-grep](https://github.com/lhotwll217/session-grep) repo — the pure,
eval-tuned grep primitive. Owner Operator wraps it (see `../sessions-grep.mjs`) to inject
its own session sources and enforce the privacy blacklist; it does **not** fork it.

- **Upstream:** https://github.com/lhotwll217/session-grep
- **Synced from:** `claude/oo-integration-exclude-pi` @ `4ae7b0f177693727f036c94bd531e95e4ff79ede`

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

1. `npx skills add lhotwll217/session-grep` (or copy `skills/session-grep/` from the repo)
   over this directory.
2. **Rename the incoming `SKILL.md` to `SKILL.upstream.md`** (see Rules above).
3. Update **Synced from** above to the new commit.
4. `node vendor/session-grep.mjs --self-test` — the primitive's own assertions.
5. Run the wrapper's integration test (`harness/src/sessions-grep.integration.test.ts`):
   the seam is stable, so a green run means the new version dropped in clean.
