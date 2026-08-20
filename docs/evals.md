---
title: "Agent evaluations"
summary: "Canonical Promptfoo paths, sandbox-user profiles, artifacts, and validity contracts"
read_when:
  - Changing an agent eval, live harness, sandbox, or comparison artifact
  - Running or reviewing the mutable Owner Operator behavioral baseline
---

# Agent evaluations

[`eval/`](../eval/) is the single Promptfoo pipeline for retrieval and mutable behavior. Its
operational command/catalog is [`eval/README.md`](../eval/README.md); this page owns the behavioral
and isolation contracts.

## Sandbox user

`createSandboxUser` in [`eval/sandbox-user.ts`](../eval/sandbox-user.ts) is the canonical disposable
user primitive. One instance owns a fresh `HOME`, `OO_HOME`, neutral task directory, SQLite state,
transcripts, temporary directory, one ephemeral daemon, production sessions, CLI invocations,
inspection, and teardown. It replaces the process environment for its lifetime because production
modules intentionally read `process.env`; therefore callers serialize sandbox users within a
process.

Profiles select only lifecycle/configuration policy:

| profile | onboarding | delegated executor | intended driver |
| --- | --- | --- | --- |
| `fresh-onboarding` | incomplete | disabled | onboarding checks |
| `already-onboarded` | complete | disabled | non-model product setup |
| `deterministic-harness` | complete | disabled | controlled behavioral fixtures |
| `live-harness` | complete | production | explicitly opted-in delegated harness checks |
| `cli-driving` | complete | disabled | repeated model-free production CLI calls against one daemon |

The live profile requires an explicit opt-in plus named credential/config source files. Every
profile uses an allowlisted child environment: ambient provider keys, agent homes, shell agents,
cloud profiles, and caller provenance (including `CODEX_THREAD_ID`) do not cross the boundary.
Network transport variables remain available. Pi model files, and explicit live-harness files when
applicable, are copied into sandbox-only homes. Before creating a production model session, Pi auth
is loaded into Pi's in-memory credential store and the copied file is deleted; the full-roster agent
therefore has no credential file to reach through file or shell tools.

Teardown shuts down tracked production sessions and the daemon, then verifies daemon discovery,
loopback reachability, and process leases. Copied credentials/configuration are deleted first. A
verified teardown deletes the disposable user; an unverified teardown retains only a structurally
sanitized diagnostic. Retained traces redact credential-bearing fields, caller provenance, and
absolute owner/sandbox paths. Never put secret values in eval option variables or fixtures.

The CLI driver accepts only model-free commands such as `--session-state`, `--done`, help,
`status`, and `doctor`. Model-bearing cases use `createProductionSession`; this keeps the full
production roster while ensuring credentials exist only in memory before the model can act.

## Mutable behavioral path

Each Promptfoo case/repeat creates its own `deterministic-harness` sandbox and calls the production
`createOwnerOperatorSession("chat", ...)` composition without `toolsAllow`, a baseline prompt, or a
reduced custom-tool list. The daemon's delegated executor is disabled; case adapters may insert
controlled run/state evidence but may not launch a child. The parent model loop, completion
delivery, configured tool roster, extensions, Ask permission posture, and real mutation tools stay
production-real.

Pi tool start/end events retain ordered arguments and results. Case assertions combine those
events with independently captured raw ledger state, active projection, transcripts, exact
completion identity/status, and an unrelated sentinel. Missing behavior is a failed grade. Missing
or malformed trajectory/state components, provider errors, invalid sandbox teardown, or a false
`harnessValid` attestation invalidate the measurement and prevent comparison-artifact publication.

## Ledgers and comparison

Every run enters [`eval/history.jsonl`](../eval/history.jsonl) and writes per-run detail. Valid
`full` and `behavioral` runs also write the same ignored `manifest.json` and
`global_results.json` pair under `eval/results/logs/<run>/`; both are accepted by
[`eval/compare.mjs`](../eval/compare.mjs). Behavioral target failures remain truthful baseline data:
`trajectory_pass` is false while `measurement_valid` is true. Only valid full retrieval suites
enter the compact committed [`eval/eval_stat_log.json`](../eval/eval_stat_log.json); behavioral runs
do not masquerade as full-suite statistics.

Use the same cases, model, reasoning level, and repeat count for before/after behavioral comparison.
Promptfoo's exit code reports case grades; the loop exits `2` only when the measurement itself is
invalid. The ignored per-case `.trace.ndjson`, `.diagnostic.json`, `.session.jsonl`, stdout, and
stderr files are the inspectable sanitized evidence.
