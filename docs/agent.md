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
`@gotgenes/pi-permission-system` owns rule
evaluation, prompts, and session grants; Owner Operator does not classify executables or shell
subcommands. The concrete core adapter reconciles only the selected defaults and marker-owned
blacklist rules into Pi's global config; it preserves advanced Pi settings and specific rules.
Blacklist paths feed Pi's cross-tool path policy as lexical and filesystem-resolved identities.
Direct `grep`, `find`, and `ls` also reject a parent whose traversal could reach a blacklisted
descendant. Bash process-internal access, non-literal paths, POSIX case variants, and repository-name
entries require separate [sandbox work](https://github.com/lhotwll217/owner-operator/issues/61).
Specific global and trusted task-repository `.pi` rules use Pi's standard precedence and may
deliberately override these defaults and generated Pi path rules; direct file-tool privacy guards
remain authoritative. Pi also floors opaque or execution-wrapper shell commands to `ask`, including
in `allow` mode.
Adoption is recorded with pinned sources in [docs/inspiration.md](inspiration.md).
