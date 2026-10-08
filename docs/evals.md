---
title: "Agent evaluations"
summary: "Canonical Promptfoo paths, sandbox-user profiles, artifacts, and validity contracts"
read_when:
  - Changing an agent eval, live harness, sandbox, or comparison artifact
  - Running or reviewing the mutable Owner Operator behavioral baseline
---

# Agent evaluations

[`eval/`](../eval/) is the single Promptfoo pipeline for retrieval, mutable behavior, and external coding agents. Its
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
Network transport variables remain available. Pi auth, settings, and model files are copied into a
sandbox-only Pi home, consumed into Pi's credential/model/settings runtime, then deleted before a
production model session is returned. All copied paths remain blacklisted as defense in depth.
Explicit live-harness credential/config files remain blacklisted for the delegated subprocess and
are deleted at teardown; that profile refuses to create a full-roster parent model while those files
exist.

Teardown shuts down tracked production sessions and the daemon, then verifies daemon discovery,
loopback reachability, and process leases. Copied credentials/configuration are deleted first. A
verified teardown deletes the disposable user; an unverified teardown retains only a structurally
sanitized diagnostic. Retained traces redact credential-bearing fields, caller provenance, and
absolute owner/sandbox paths. Never put secret values in eval option variables or fixtures.

The CLI driver accepts only model-free commands: operation nouns such as `session-state`, help,
`status`, and `doctor`. Model-bearing cases use `createProductionSession`; this keeps the full
production roster while ensuring credentials exist only in memory before the model can act.

### Runnable examples

Run programmatic checks from the repository root. The `finally` block is mandatory because it
stops the sandbox daemon and verifies teardown before deleting the disposable user.

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSandboxUser } from "./eval/sandbox-user.ts";

const sandbox = await createSandboxUser({
  profile: "already-onboarded",
  root: mkdtempSync(join(tmpdir(), "oo-programmatic-")),
});
try {
  console.log(sandbox.daemon.state.listCurrentSessionState());
} finally {
  const closed = await sandbox.close();
  if (!closed.teardownVerified) throw new Error("sandbox teardown was not verified");
}
```

For a production CLI call, let the primitive supply the explicit temporary `HOME`, `OO_HOME`, and
already-running ephemeral daemon. This command is directly runnable from the repository root:

```sh
node --import tsx --input-type=module <<'EOF'
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSandboxUser } from "./eval/sandbox-user.ts";

const sandbox = await createSandboxUser({
  profile: "cli-driving",
  root: mkdtempSync(join(tmpdir(), "oo-cli-")),
});
try {
  const result = await sandbox.runCli(["session-state", "list", "--json"]);
  process.stdout.write(result.stdout);
  if (result.exitCode !== 0) throw new Error(result.stderr);
} finally {
  const closed = await sandbox.close();
  if (!closed.teardownVerified) throw new Error("sandbox teardown was not verified");
}
EOF
```

## Mutable behavioral path

Each Promptfoo case/repeat creates its own `deterministic-harness` sandbox and calls the production
`createOwnerOperatorSession("chat", ...)` composition without `toolsAllow`, a baseline prompt, or a
reduced custom-tool list. The daemon's delegated executor is disabled; case adapters may supply
controlled harness observations and baseline candidates (through the sandbox daemon's `harness`
option, which the Operator's `oo harness` reaches), requested-tool permission outcomes, and
run/state evidence, but may not launch a child. The parent model loop, completion delivery,
configured tool roster, extensions, production default-Allow posture, and real mutation tools stay
production-real. Explicit project and user deny rules still refine that permissive baseline, and
Owner Operator's blacklist enforcement remains authoritative.

Pi tool start/end events retain ordered arguments and results. Case assertions combine those
events with independently captured raw ledger state, active projection, transcripts, exact
completion identity/status, and an unrelated sentinel. Missing behavior is a failed grade. Missing
or malformed trajectory/state components, provider errors, invalid sandbox teardown, or a false
`harnessValid` attestation invalidate the measurement and prevent comparison-artifact publication.

## External coding agents

The `external-codex` and `external-claude-code` subjects run Codex or Claude Code through
Promptfoo's native SDK providers (`openai:codex-sdk`, `anthropic:claude-agent-sdk`). The agent
gets an ordinary task plus the measured checkout's `skills/owner-operator/SKILL.md`, and reaches
Owner Operator only through that checkout's `oo` CLI. `npm run eval:external -- --help` lists the
subject options.

`metadata.subjects` in [`eval/cases.yaml`](../eval/cases.yaml) declares which subjects may attempt
each case, and [`eval/loop.mjs`](../eval/loop.mjs) derives a subject's suite from it. Retrieval
questions are answerable through the CLI, so they are measured on the external subjects too, and
each exclusion carries its reason beside the declaration. Promptfoo's own test-level `providers`
filter cannot hold this: it is validated against the post-`--filter-providers` provider list, so a
declaration naming the other subjects aborts a single-subject run.

Each sample runs [`eval/external/trial.mjs`](../eval/external/trial.mjs) in its own process,
because a sandbox user owns `process.env` and an in-process daemon. The trial builds a
`cli-driving` sandbox from `--checkout` and seeds the shared fixture sessions; a case opts into
any extra fixture it needs through its own vars, so every other case keeps the shared ground
truth. Host instructions, skills, MCP servers, and settings stay out. `--credential` names the
auth file the harness reads from its config directory: Codex `auth.json`, Claude Code
`.credentials.json`. The trial copies it into the sandbox, blacklists it, deletes it at teardown,
and scrubs its values from every returned field. This isolates configuration and fixture data; it
is not an OS security sandbox for hostile agents.

An instrumented `oo` comes first on the login shell's PATH. It forwards to the checkout's CLI and
records each call's arguments, effective caller, exit status, and output, and it plants a
transcript under the agent's real session id that caller-identity exclusion must keep out of
search. Those recorded calls reach [`asserts/tool-use.mjs`](../eval/asserts/tool-use.mjs) in the
same execution shape the embedded Operator produces, so one behavior gate grades every subject and
a case's existing tool expectations apply unchanged. Caller identity, caller-transcript exclusion,
and required evidence from a named session sit beside that gate, since only an external caller has
a session identity to declare.

Validity follows the behavioral path: provider errors, a missing answer or trajectory, a worker
that reports the wrong shape, and unverified teardown invalidate the run, and the first provider
error stops later samples. A wrong answer or missing evidence is a valid failure. To compare
checkouts, run the same subject, model, effort, executable, and repeat once per checkout, then
`compare.mjs` the two `global_results.json` files. The manifest's git fields identify the measured
checkout; `external.runner` records the evaluation code.

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
