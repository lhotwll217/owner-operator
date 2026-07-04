# Inspiration

We'd rather borrow a battle-tested, maintained pattern than invent a less robust one.
Before designing anything new — architecture, protocol, repo convention — check these
sources for prior art, and go looking for others when they don't cover it. Cite the source
in the issue/PR so the borrow is traceable.

## OpenClaw — [github](https://github.com/openclaw/openclaw) · [docs](https://docs.openclaw.ai)

The closest architectural sibling: a local-first agent hub, much further down the same road.

- **Gateway architecture** ([concepts/architecture](https://docs.openclaw.ai/concepts/architecture),
  [gateway](https://docs.openclaw.ai/gateway)): one long-lived process owns all state; every
  surface is a thin client over one protocol. Our daemon follows this; promoting it to a true
  top-level gateway (agent → gateway, never the reverse) is
  [#14](https://github.com/lhotwll217/owner-operator/issues/14).
- **Repo practice**: pi consumed as pinned npm deps, not a fork (we do the same); oxlint for
  static checks; problem-first issue/PR templates; CI gating every PR.

## pi — [github](https://github.com/earendil-works/pi)

The agent toolkit we build on (`@earendil-works/pi-*`): sessions, tools, skills, print/RPC
modes, TUI primitives. Before hand-rolling agent plumbing, check whether pi already ships it
([#7](https://github.com/lhotwll217/owner-operator/issues/7) — its interactive-mode vs our
hand-rolled TUI — is this question in issue form).

## session-grep — [github](https://github.com/lhotwll217/session-grep)

The standalone search primitive we vendor and wrap
([#20](https://github.com/lhotwll217/owner-operator/issues/20)): the house pattern for
consuming a shared primitive — the wrapper owns only local policy (sources, blacklist), so an
upstream release drops into `vendor/` untouched.
