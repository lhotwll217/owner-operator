# Glossary

Canonical terms for Owner Operator. Code, docs, and issues use these words with exactly these meanings.

- **Owner** — the human user. Never "operator".
- **Operator** — the AI agent acting over the owner's sessions.
- **Install root** — the checkout or package the executable runs from. Carries code and bundled resources (prompt, tools, skills). Never a source of agent context.
- **Harness home (`OO_HOME`)** — the directory owning durable product state: config, credentials, SQLite, transcripts, logs, daemon files. Defaults to `~/.owner-operator`.
- **Agent workspace (`OO_HOME/workspace`)** — the Operator's persistent working directory: its instruction file (`AGENTS.md`), workspace skills, memory, and artifacts. Auto-created and seeded on any entry point; owner-edited files are never overwritten.
- **Task cwd** — the file/command target of a single run. Selects what a run operates on; never selects persona, instructions, or resource catalogs.
- **Onboarding** — the interactive elicitation flow that writes owner decisions into config. Every setting it writes has a least-permissive default; onboarding relaxes or configures, never creates capability. Gated by a versioned run-once marker; a stale marker re-triggers only missing steps.
- **Privacy blacklist** — owner-declared paths and repository names (`OO_HOME/blacklist.json`) excluded from discovery and storage. Scanning and storage enforce both. Direct file-tool targets enforce both, while recursive tools also block blacklisted path descendants. Pi's cross-tool path policy receives each path's lexical and filesystem-resolved identities. Repository-name entries do not gate parent traversal or Bash; Bash process-internal access, non-literal paths, and POSIX case variants require the OS sandbox tracked in [#61](https://github.com/lhotwll217/owner-operator/issues/61).
- **Tool posture** — which built-in tools exist in a thread. Posture controls availability; permissions control use.
- **Permission mode** — the owner-selected global baseline: ask before shell commands and changes, allow them, or read-only without shell access. Missing or invalid settings use read-only until the owner selects a mode. The maintained Pi permission system applies rules, prompts for `ask`, and records session approvals. Headless scheduled prompts inherit this baseline; specific global and trusted task-repository `.pi` rules may override it, including generated Pi path rules. Direct privacy guards remain authoritative. Blacklisted paths are also written into Pi's path policy.
- **Skill policy** — the explicit config declaring which skill sources are visible: bundled Owner Operator skills and workspace skills by default; personal `~/.agents/skills` only by owner opt-in.
- **Agent harness** — a coding-agent runtime that conducts the model/tool loop and produces a session history, such as Claude Code, Codex, or Pi. A host may launch several harnesses.
- **Transcript format** — the record shape Owner Operator can parse for one harness. Supporting a harness requires a known transcript format; recognizing its host is not enough.
- **Transcript store** — a directory containing session histories in one transcript format. Stores are detected or owner-configured; transcript access is granted at this boundary.
- **Session host** — the owner-facing CLI or app that launches or presents a session, such as Claude CLI, Claude App, Superset, or Conductor. A host identifies where the owner returns; it does not grant transcript access.
