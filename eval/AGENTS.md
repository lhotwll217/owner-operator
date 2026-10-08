# Eval development

Before changing evals, read [the contracts](../docs/evals.md) and
[the code catalog](README.md). When running a campaign or assessing merge readiness,
follow [the iteration and closeout protocol](AUTORESEARCH.md).

- **Reuse.** Add subjects and cases through the canonical Promptfoo pipeline.
  Use native providers and declarative configuration wherever they satisfy the
  requirement.
- **Prior art is required before introducing a new pattern.** Read the relevant
  [official Promptfoo docs](https://www.promptfoo.dev/docs/intro/),
  [upstream examples](https://github.com/promptfoo/promptfoo/tree/main/examples),
  and the closest working implementation in this repository. Verify compatibility
  with the installed version. Introduce a new pattern only after identifying a
  concrete requirement the existing patterns cannot satisfy. Cite the sources
  checked and explain that gap in the PR.
- **Extend shared infrastructure.** Keep custom adapters focused on
  Owner Operator setup, execution evidence, and assertions; extend shared lifecycle,
  reporting, and comparison code in place.
- **Consolidate.** A replacement is complete when it preserves the required behavior
  and removes the superseded path. Keep one implementation of each shared capability.
  This preserves the consolidation decision in
  [#135](https://github.com/lhotwll217/owner-operator/issues/135).
- **Observe.** Give subjects ordinary tasks and keep grading expectations outside
  their context. Grade outcomes and evidence; require a tool sequence only when that
  sequence is the behavior under test.
