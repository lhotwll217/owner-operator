# Harness resource boundaries

Research date: 2026-07-13. OpenClaw was checked at the repository-pinned
`372b527da4a1cee5b819e7852f6e26ef11160e85` and current upstream
`b0ebb81e89f5217397d409c996e2bbf914623a94`; Hermes Agent was checked at current
upstream `f96b2e6ef75ba6ed678c99954bc8f3ee7f6a38ba`.

## Finding

Owner Operator currently isolates its database and transcripts, but not its
agent runtime resources. Its effective harness is split across three roots:

| Root | Current responsibility |
| --- | --- |
| `~/.owner-operator` | SQLite state, transcripts, daemon files |
| `~/.pi/agent` | Model settings, authentication, extensions, skills, prompts, themes, and optional global `AGENTS.md` |
| Owner Operator source checkout | Runtime cwd, project `AGENTS.md`, project `.pi` resources, bundled prompt, and bundled skills |

`OO_HOME` is unset in the inspected installation. Product state therefore
defaults to `~/.owner-operator` ([`src/shared/paths.ts:4`](../src/shared/paths.ts)),
while `AuthStorage.create()`, `SettingsManager.create(repoRoot)`, `getAgentDir()`,
and an unconstrained `DefaultResourceLoader` retain Pi's global/project resource
behavior ([`src/agent/agent.ts:115-130`](../src/agent/agent.ts)). The existing
integration test treats Pi project and user skills as required Owner Operator
behavior ([`src/agent/skills.integration.test.ts:21-46`](../src/agent/skills.integration.test.ts)).
Interactive sessions use the source checkout as their cwd
([`src/cli/interactive.ts:64-68`](../src/cli/interactive.ts)); scheduled sessions
use the schedule's requested cwd ([`src/agent/agent.ts:261-282`](../src/agent/agent.ts)).
Consequently, changing cwd also changes ambient instructions and resource
discovery.

This is a real harness-boundary problem. The source checkout is serving as an
accidental agent workspace, and Pi's user directory is serving as an accidental
Owner Operator config/plugin/skill home.

## OpenClaw

OpenClaw treats the embedded agent runtime as OpenClaw-owned. Its integration
with Pi disables ambient extensions, skills, prompt templates, themes, and
context files, including `noContextFiles: true`
([source](https://github.com/openclaw/openclaw/blob/b0ebb81e89f5217397d409c996e2bbf914623a94/src/agents/embedded-agent-runner/resource-loader.ts#L6-L33)).
It then loads a bounded set of bootstrap files from an explicitly resolved
OpenClaw workspace. This is an allowlisted replacement for ambient discovery,
not a context-free runtime.

The default workspace is `~/.openclaw/workspace`, separate from config,
credentials, and sessions. It is the default cwd and contains the harness's
`AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, memory, skills, and ordinary
workspace files
([workspace contract](https://github.com/openclaw/openclaw/blob/b0ebb81e89f5217397d409c996e2bbf914623a94/docs/concepts/agent-workspace.md#L10-L42),
[file map](https://github.com/openclaw/openclaw/blob/b0ebb81e89f5217397d409c996e2bbf914623a94/docs/concepts/agent-workspace.md#L62-L120)).
Workspace bootstrap files are read through workspace-root boundary checks;
their per-session cache is refreshed each turn, so edits become visible to
long-lived sessions
([source](https://github.com/openclaw/openclaw/blob/b0ebb81e89f5217397d409c996e2bbf914623a94/src/agents/bootstrap-cache.ts#L1-L68)).

OpenClaw gives skills named scopes and precedence: workspace, workspace
`.agents`, personal `~/.agents`, OpenClaw-managed, bundled, then explicitly
configured extra/plugin directories. It does not inherit Codex's native skill
home; migration is explicit
([source](https://github.com/openclaw/openclaw/blob/b0ebb81e89f5217397d409c996e2bbf914623a94/docs/tools/skills.md#L32-L62)).
Skills are session snapshots but the default watcher refreshes them on the next
turn after `SKILL.md` changes
([source](https://github.com/openclaw/openclaw/blob/b0ebb81e89f5217397d409c996e2bbf914623a94/docs/tools/skills.md#L531-L562)).
Plugin code changes require a gateway restart, with managed installs performing
that restart automatically
([source](https://github.com/openclaw/openclaw/blob/b0ebb81e89f5217397d409c996e2bbf914623a94/docs/tools/plugin.md#L76-L100)).

OpenClaw profiles and agents separate workspace, per-agent auth/config state,
and sessions. A task runtime may use a task cwd while persona/bootstrap files
remain tied to the agent workspace
([source](https://github.com/openclaw/openclaw/blob/b0ebb81e89f5217397d409c996e2bbf914623a94/src/agents/embedded-agent-runner/run/attempt.ts#L1425-L1449)).

## Hermes Agent

Hermes also owns a first-class harness home. `~/.hermes` contains config,
secrets, auth, identity, memory, skills, cron, sessions, and logs
([source](https://github.com/NousResearch/hermes-agent/blob/f96b2e6ef75ba6ed678c99954bc8f3ee7f6a38ba/website/docs/user-guide/configuration.md#L7-L28)).
Named profiles are complete alternate `HERMES_HOME` roots with independent
config, credentials, memory, sessions, skills, plugins, and gateway state
([source](https://github.com/NousResearch/hermes-agent/blob/f96b2e6ef75ba6ed678c99954bc8f3ee7f6a38ba/website/docs/user-guide/profiles.md#L5-L23)).

Hermes differs from OpenClaw because it is also a project coding harness. It
keeps the profile home separate from the working directory, loads the harness
identity from `$HERMES_HOME/SOUL.md`, and deliberately loads project context
from the configured/launch cwd
([profile/workspace distinction](https://github.com/NousResearch/hermes-agent/blob/f96b2e6ef75ba6ed678c99954bc8f3ee7f6a38ba/website/docs/user-guide/profiles.md#L125-L149),
[loader source](https://github.com/NousResearch/hermes-agent/blob/f96b2e6ef75ba6ed678c99954bc8f3ee7f6a38ba/agent/prompt_builder.py#L1819-L1847),
[project context source](https://github.com/NousResearch/hermes-agent/blob/f96b2e6ef75ba6ed678c99954bc8f3ee7f6a38ba/agent/prompt_builder.py#L1947-L1994)).
Hermes prevents dynamically discovered subdirectory instructions from escaping
the active working-directory tree specifically to prevent cross-agent context
contamination
([source](https://github.com/NousResearch/hermes-agent/blob/f96b2e6ef75ba6ed678c99954bc8f3ee7f6a38ba/agent/subdirectory_hints.py#L169-L212)).

Hermes-owned skills live under `$HERMES_HOME/skills`. Shared directories such
as `~/.agents/skills` are imported only through `skills.external_dirs`, with
local precedence and explicit warnings that writable imports are not an
isolation boundary
([source](https://github.com/NousResearch/hermes-agent/blob/f96b2e6ef75ba6ed678c99954bc8f3ee7f6a38ba/website/docs/user-guide/features/skills.md#L315-L355)).
User plugins live under `$HERMES_HOME/plugins`, are opt-in, and project-local
plugins are disabled by default
([source](https://github.com/NousResearch/hermes-agent/blob/f96b2e6ef75ba6ed678c99954bc8f3ee7f6a38ba/website/docs/user-guide/features/plugins.md#L19-L31),
[discovery and trust](https://github.com/NousResearch/hermes-agent/blob/f96b2e6ef75ba6ed678c99954bc8f3ee7f6a38ba/website/docs/user-guide/features/plugins.md#L90-L128)).
Hermes normally applies identity changes on a new session and defers changes
that would invalidate a conversation's cached prompt, with an explicit `--now`
escape hatch
([profile behavior](https://github.com/NousResearch/hermes-agent/blob/f96b2e6ef75ba6ed678c99954bc8f3ee7f6a38ba/website/docs/user-guide/profiles.md#L143-L149),
[cache policy](https://github.com/NousResearch/hermes-agent/blob/f96b2e6ef75ba6ed678c99954bc8f3ee7f6a38ba/AGENTS.md#L1128-L1142)).

## Owner Operator boundary

Owner Operator is a persistent personal harness, so the OpenClaw workspace
shape is the closer default. The minimal coherent contract is:

| Scope | Proposed path and behavior |
| --- | --- |
| Install/source | Code, bundled prompt, bundled tools, bundled skills; never an agent context root |
| Harness home | `~/.owner-operator`; config, credentials or explicit credential import, SQLite, sessions, logs, daemon metadata |
| Agent workspace | `~/.owner-operator/workspace`; harness `AGENTS.md`, user/profile files, memory, ordinary artifacts, workspace skills |
| Task cwd | Explicit per scheduled run; controls file/tool resolution but does not silently replace the harness workspace or persona |
| Shared resources | Explicit imports/allowlists with source and precedence shown in status output |

Implementation should constrain Pi's resource loader (`noContextFiles`,
`noExtensions`, `noSkills`, `noPromptTemplates`, and `noThemes`) and then add
back Owner Operator-owned resources explicitly. `noContextFiles: true` fixes
the checkout leak, while the Owner Operator workspace supplies the supported
customization seam.

`~/.owner-operator/workspace/AGENTS.md` should be the documented persistent
instruction file. Files under `workspace/artifacts/` should be available to
file tools but should not be injected wholesale; `AGENTS.md`, a skill, or the
user should reference what needs to be read. Owner Operator skills should live
under `workspace/skills` or a distinct `~/.owner-operator/skills` managed scope.
Importing `~/.agents/skills` can remain available as an explicit opt-in, not a
Pi inheritance side effect.

The initial reload contract can stay small: new headless/scheduled sessions
load current workspace resources; interactive sessions apply changes on
`/reload` or a new session; executable plugin/extension changes require process
restart. A status surface should report the harness home, workspace, task cwd,
loaded context files, skill roots, and credential/config source.
