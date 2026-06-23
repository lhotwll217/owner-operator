# harness/test

Shared test infra and cross-cutting e2e. Module-bound tests stay colocated with their source
(`*.test.ts` next to the file). See [docs/testing.md](../../docs/testing.md) for the tier
taxonomy and the hermetic rule.

- **`fixtures/<source>/`** — committed, **sanitized** session corpus (no personal
  paths/repos/names), one dir per source: `claude/` · `codex/` · `cursor/` · `posthog-code/`.
  Scaffolded and ready; empty today since we build fixtures inline. Promote one into its
  source dir once it's reused or too bulky to inline. Conductor/Superset are *hosts*, not
  sources — tested as a cwd-marker variant inside a source's fixture, never their own dir.
- **`helpers/index.ts`** — shared harness, imported from a colocated test as `../test/helpers`:
  `tempOoHome` (throwaway `$OO_HOME` + cleanup), `fakeScanRow`, `waitFor`. Promote a helper
  here only once a second test needs it.
- **`e2e/`** — full-stack tests not bound to one module (e.g. launch the real `oo` CLI and
  assert a `--json` snapshot).
- **`run.mjs`** — the tier runner. `node test/run.mjs <unit|integration|e2e>` globs the
  matching `*.test.ts` under `harness/` and runs each via tsx, fail-fast.

Empty dirs are held by `.gitkeep` until populated.
