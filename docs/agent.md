---
title: "Agent"
summary: "How Owner Operator uses Pi: embedded runtime, workspace roots, tools, skills, permissions"
read_when:
  - Changing the product prompt, tools, skills, or permission posture
  - Tracing what the embedded agent can reach and why
---

# Agent

Owner Operator is built on the [pi coding agent](https://github.com/earendil-works/pi),
consumed as npm dependencies (`@earendil-works/pi-*`), pinned exact while pre-1.0. Embedded
Pi uses `OO_HOME/pi` for its auth, settings, custom models, and agent state; it does not
change standalone Pi. The resource loader disables ambient context, extensions, skills,
prompts, and themes, then adds only the product prompt, bundled skills, workspace
`AGENTS.md`, workspace skills, and personal skills explicitly selected during onboarding,
plus the pinned permission-system extension.

## Roots

Code and agent state have separate roots:

| Scope | Path | Responsibility |
|---|---|---|
| Install root | checkout/package | executable code and bundled prompt, tools, and skills |
| Harness home | `OO_HOME` or `~/.owner-operator` | config, copied credentials/model settings, SQLite, transcripts, logs, daemon files |
| Agent workspace | `OO_HOME/workspace` | persistent `AGENTS.md`, memory, artifacts, and workspace skills |
| Task cwd | caller or scheduled-run cwd | file and command target for that run |

Every entry point creates missing workspace files without overwriting owner edits.

The core config API is authoritative; onboarding is its first-run TTY client. Before the versioned
consent marker is complete,
the daemon does not scan or enrich transcripts, headless model calls return setup-required, and the
widget displays setup-required. `oo doctor` and `oo status` report the effective boundary without
printing credential values.

## Tools and skills

- **Tools** are executable, typed Pi capabilities defined under `src/agent/tools`. Same-name direct
  file-tool guards at the Agent boundary enforce explicit path, repository-name, and symlinked-path
  blacklists. The Bash wrapper supplies the task cwd and Owner Operator provenance environment.
- **Skills** are standard Agent Skills under `src/agent/skills`; each `SKILL.md` may bundle the
  scripts and private vendored dependencies needed to follow its workflow.
- `session-search` is such a skill: Pi's native `bash` invokes its policy wrapper, which executes
  the pinned upstream `session-grep` CLI. The wrapper—not application runtime code—owns local
  source mapping, blacklist policy, and the decision to exclude the caller during discovery.
  Caller identity comes from provenance. Owner Operator's own saved conversations remain a
  separate, explicit wrapper scope rather than entering default coding-session discovery.
  The vendored primitive owns canonical-ID exclusion and its opt-in candidate aperture, which
  groups the complete ranked match set by stable session ID before applying limits or output
  budgets; literal/IDF ranking remains unchanged.
- `.claude/skills` contains development-agent instructions and is never loaded by the product agent.

## Permissions

The built-in posture exposes `read`, `grep`, `find`, `ls`, `bash`, `edit`, and `write`. The owner
selects a permission mode during onboarding and changes it later with `/permissions`.

Permission gating is
[`@gotgenes/pi-permission-system`](https://pi.dev/packages/pi-permission-system) (pinned exact in
`package.json`), not local code. It already provides deterministic allow/ask/deny rules, Bash
decomposition, cross-tool path gates, and once/session approval prompts
([source](https://github.com/gotgenes/pi-packages/blob/a9fc65d8878cc8265d5fc952e9e3dc057a1a7c81/packages/pi-permission-system/README.md#L12-L47)).
Its global config respects `PI_CODING_AGENT_DIR`
([source](https://github.com/gotgenes/pi-packages/blob/a9fc65d8878cc8265d5fc952e9e3dc057a1a7c81/packages/pi-permission-system/docs/configuration.md#L5-L12)),
so Owner Operator roots it under `OO_HOME/pi`. Owner Operator writes only three baseline modes and
marker-owned blacklist path rules for each lexical and filesystem-resolved identity because the
extension matches both access forms
([source](https://github.com/gotgenes/pi-packages/blob/a9fc65d8878cc8265d5fc952e9e3dc057a1a7c81/packages/pi-permission-system/src/access-intent/access-path.ts#L87-L115)).
The package exports only its service entry point
([source](https://github.com/gotgenes/pi-packages/blob/a9fc65d8878cc8265d5fc952e9e3dc057a1a7c81/packages/pi-permission-system/package.json#L1-L8)),
so core's small `pathIdentities` adapter follows its best-effort existing-ancestor resolution
([source](https://github.com/gotgenes/pi-packages/blob/a9fc65d8878cc8265d5fc952e9e3dc057a1a7c81/packages/pi-permission-system/src/path/canonicalize-path.ts#L5-L36))
without importing an unsupported internal path.
Targeted JSONC edits preserve comments, specific user rules, and extension settings. Owner Operator does
not maintain executable or shell-subcommand classifiers. Pattern maps use the extension's broad-first,
last-match-wins contract
([source](https://github.com/gotgenes/pi-packages/blob/a9fc65d8878cc8265d5fc952e9e3dc057a1a7c81/packages/pi-permission-system/src/config-schema.ts#L55-L87)).
Its Bash safety floors can raise opaque or execution-wrapper commands from `allow` to `ask`
([source](https://github.com/gotgenes/pi-packages/blob/a9fc65d8878cc8265d5fc952e9e3dc057a1a7c81/packages/pi-permission-system/docs/configuration.md#L319-L331));
headless calls cannot approve those prompts.
Project rules still resolve from the task cwd
([source](https://github.com/gotgenes/pi-packages/blob/a9fc65d8878cc8265d5fc952e9e3dc057a1a7c81/packages/pi-permission-system/src/permission-manager.ts#L388-L401));
project rules are therefore trusted task policy and may override the global baseline and generated
Pi path rules.

The direct file-tool privacy guard remains authoritative for explicit paths, repository names,
symlink resolution, and traversal that could reach a blacklisted descendant. OS enforcement for Bash
process-internal access, non-literal paths, POSIX case variants, and repository-name entries is scoped
to [#61](https://github.com/lhotwll217/owner-operator/issues/61), which starts from Anthropic Sandbox
Runtime and an existing Pi adapter.
