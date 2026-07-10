# test

Cross-cutting tests live here; module-bound tests stay colocated under `src`. See
[docs/testing.md](../docs/testing.md) for the tier taxonomy and hermetic rule.

- **`run.mjs`** discovers the selected `*.test.ts`, `*.integration.test.ts`, or
  `*.e2e.test.ts` tier anywhere under `src/` and `test/`, then runs each file through tsx,
  fail-fast.
- **`eval-daemon.integration.test.ts`** covers the managed eval daemon lifecycle.
- **`scan.integration.test.ts`** covers the real transcript scanner across session files and git.
- **`sessions-grep.integration.test.ts`** covers the vendored session-search primitive and privacy
  boundaries.

Shared cross-seam helpers currently live at
[`src/gateway/test/helpers`](../src/gateway/test/helpers/index.ts). Promote sanitized fixtures only
when reuse makes inline test data unwieldy.
