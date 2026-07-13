# Glossary

Canonical terms for Owner Operator. Code, docs, and issues use these words with exactly these meanings.

- **Owner** — the human user. Never "operator".
- **Operator** — the AI agent acting over the owner's sessions.
- **Install root** — the checkout or package the executable runs from. Carries code and bundled resources (prompt, tools, skills). Never a source of agent context.
- **Harness home (`OO_HOME`)** — the directory owning durable product state: config, credentials, SQLite, transcripts, logs, daemon files. Defaults to `~/.owner-operator`.
- **Agent workspace (`OO_HOME/workspace`)** — the Operator's persistent working directory: its instruction file (`AGENTS.md`), workspace skills, memory, and artifacts. Auto-created and seeded on any entry point; owner-edited files are never overwritten.
- **Task cwd** — the file/command target of a single run. Selects what a run operates on; never selects persona, instructions, or resource catalogs.
- **Onboarding** — the interactive elicitation flow that writes owner decisions into config. Every setting it writes has a least-permissive default; onboarding relaxes or configures, never creates capability. Gated by a versioned run-once marker; a stale marker re-triggers only missing steps.
- **Privacy blacklist** — the absolute denylist of owner-declared paths (`OO_HOME/blacklist.json`): never scanned, stored, shown, or reachable through any tool, including bash equivalents. Not a permission profile; nothing prompts to bypass it.
- **Tool posture** — which built-in tools exist in a thread. Posture controls availability; the gate policy controls use.
- **Gate policy** — per-operation `allow`/`ask`/`deny`. `ask` requires owner confirmation in context; without a TTY, `ask` degrades to `deny`. Reads and safe commands are `allow`; mutations (edit, write, risky bash) are `ask`. The blacklist is `deny` on every route, always.
- **Skill policy** — the explicit config declaring which skill sources are visible: bundled Owner Operator skills and workspace skills by default; personal `~/.agents/skills` only by owner opt-in.
- **Agent harness** — a coding-agent runtime that conducts the model/tool loop and produces a session history, such as Claude Code, Codex, or Pi. A host may launch several harnesses.
- **Transcript format** — the record shape Owner Operator can parse for one harness. Supporting a harness requires a known transcript format; recognizing its host is not enough.
- **Transcript store** — a directory containing session histories in one transcript format. Stores are detected or owner-configured; transcript access is granted at this boundary.
- **Session host** — the owner-facing CLI or app that launches or presents a session, such as Claude CLI, Claude App, Superset, or Conductor. A host identifies where the owner returns; it does not grant transcript access.
