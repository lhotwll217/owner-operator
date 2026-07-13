# Agent runtime context boundaries

## Conclusion

This is already an implemented agent-runtime boundary, although it is not a single
cross-vendor standard. The useful separation is:

1. product-owned prompt and shipped resources;
2. the session working directory used by tools and persistence;
3. optional ambient project instructions and customization discovered from that directory.

Pi already exposes these as separate inputs. Owner Operator does not need a neutral dummy
working directory or a new resource loader to stop loading its development `AGENTS.md`; it
should set Pi's existing `noContextFiles: true` in the shared product resource-loader options.
That leaves its explicit system prompt, bundled skill path, tool cwd, and session cwd intact.

## Pi has the exact seam

The pinned `@earendil-works/pi-coding-agent@0.80.6` resource loader accepts `cwd`,
`agentDir`, explicit extra resource paths, independent system-prompt overrides, and
`noContextFiles` as separate options
([interface](https://github.com/earendil-works/pi/blob/2b3fda9921b5590f285165287bd442a25817f17b/packages/coding-agent/src/core/resource-loader.ts#L122-L156)).
Its ambient context discovery checks `AGENTS.md`/`CLAUDE.md` in the agent directory and every
ancestor from `cwd`
([discovery](https://github.com/earendil-works/pi/blob/2b3fda9921b5590f285165287bd442a25817f17b/packages/coding-agent/src/core/resource-loader.ts#L67-L120)).
During reload, `noContextFiles` makes that result an empty array; system-prompt resolution is
a later, independent step
([reload](https://github.com/earendil-works/pi/blob/2b3fda9921b5590f285165287bd442a25817f17b/packages/coding-agent/src/core/resource-loader.ts#L463-L488)).
Pi's own CLI exposes the same policy as `--no-context-files`
([documentation](https://github.com/earendil-works/pi/blob/2b3fda9921b5590f285165287bd442a25817f17b/packages/coding-agent/README.md#L314-L327)).

Owner Operator already supplies its product prompt explicitly and adds its bundled skills by
absolute path, but leaves context discovery at Pi's default
([session composition](https://github.com/lhotwll217/owner-operator/blob/23c4f0d34f92a47a0fb2862c21bc15d83a576280/src/agent/agent.ts#L115-L141),
[bundled skill path](https://github.com/lhotwll217/owner-operator/blob/23c4f0d34f92a47a0fb2862c21bc15d83a576280/src/agent/skills.ts#L1-L7)).
The interactive surface deliberately passes `repoRoot` as its cwd, so default discovery makes
the implementation checkout's `AGENTS.md` product input
([interactive runtime](https://github.com/lhotwll217/owner-operator/blob/23c4f0d34f92a47a0fb2862c21bc15d83a576280/src/cli/interactive.ts#L36-L68)).
The eval avoids that one file only incidentally by substituting a sandbox cwd
([eval invocation](https://github.com/lhotwll217/owner-operator/blob/23c4f0d34f92a47a0fb2862c21bc15d83a576280/eval/providers/pi-agent-core.mjs#L209-L227)).

The important correction is therefore: the cwd is not itself the defect. Pi is behaving as a
coding-agent runtime normally should. The defect is that an embedded product agent did not opt
out of a cwd-derived input class that Pi already makes optional.

## Anthropic uses the same three-way model

Claude Agent SDK separately exposes `cwd`, programmatic `systemPrompt`, and
`settingSources`. Its current behavior loads user, project, and local filesystem settings when
`settingSources` is omitted, while an explicit `settingSources: []` limits the agent to
programmatic configuration
([filesystem settings](https://code.claude.com/docs/en/agent-sdk/claude-code-features#control-filesystem-settings-with-settingsources)).
The docs state that `cwd` determines where project inputs are sought and enumerate project
`CLAUDE.md`, rules, skills, hooks, and settings as the ambient classes controlled by that
separate switch
([sources and locations](https://code.claude.com/docs/en/agent-sdk/claude-code-features#control-filesystem-settings-with-settingsources)).
They also recommend an explicit empty setting-source list, plus filesystem isolation for other
host-level inputs, in multi-tenant deployment
([isolation guidance](https://code.claude.com/docs/en/agent-sdk/claude-code-features#what-settingsources-does-not-control)).

This is the closest maintained precedent for Owner Operator: retain a meaningful workspace for
tools while independently disabling ambient instructions for an application-defined agent.

## Codex and MCP clarify the boundary, but are not the fix

Codex is evidence that cwd-derived instructions are intentional for a *coding workspace*, not
that every embedded agent should inherit them. Its documented algorithm builds an instruction
chain from the project root down to the current working directory
([AGENTS.md discovery](https://developers.openai.com/codex/guides/agents-md#how-codex-discovers-guidance));
its configuration separately exposes explicit developer instructions and project-document
discovery controls
([configuration reference](https://developers.openai.com/codex/config-reference)).
Owner Operator is not acting as the coding agent for its own implementation checkout, so copying
Codex's default coupling would preserve the category error.

MCP Roots standardizes how a client communicates relevant filesystem locations to a server, and
MCP Prompts is a separate primitive. Roots are advisory workspace scope, not a control over the
host agent's `AGENTS.md`/`CLAUDE.md` loading
([Roots](https://modelcontextprotocol.io/specification/2025-06-18/client/roots),
[Prompts](https://modelcontextprotocol.io/specification/2025-06-18/server/prompts)).
MCP supports the conceptual separation, but it does not supply the local fix.

## Recommendation for Owner Operator

Add `noContextFiles: true` to `ownerOperatorResourceLoaderOptions()` so every Owner Operator
surface—including interactive, headless chat, schedules, and eval—shares the policy. Keep:

- the explicit Owner Operator system prompt;
- the explicit bundled skill path;
- the real tool/session cwd required by each surface;
- caller cwd as recorded provenance where appropriate.

Add a regression test that creates an `AGENTS.md` and a `CLAUDE.md` above the runtime cwd, loads
the shared options, and asserts `getAgentsFiles().agentsFiles` is empty while the product prompt
and bundled skills remain loaded. A prompt/context manifest is useful observability, but it is
not required to enforce the boundary.

Pi also has independent `noSkills`, `noExtensions`, `noPromptTemplates`, and `noThemes` switches.
Whether Owner Operator should disable those ambient customization classes is a separate product
policy decision. It should not be bundled into the `AGENTS.md` fix unless deterministic product
composition is intended across all of them.
