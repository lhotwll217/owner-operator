# Owner Operator — Vision

## One line

A local-first **chief of staff** for everything running on your machine — across every
coding agent you use — that tells you **the most valuable thing to work on next** and
makes it frictionless to act on it.

## Who it's for

People who do the bulk of their coding through agents, locally, across multiple tools
(Claude Code, Codex, OpenCode, Conductor, and friends) — parallelizing more sessions and
threads, across more projects, than one head can keep up with.

## The problem

- **No global view.** At any moment you don't know what's blocked, what's waiting on a
  reply, or what needs attention. The state lives in your head, and it slips.
- **No prioritization.** Even when you can see everything, you don't know *which* thread
  is the most valuable thing to touch right now.
- **No interrupt scheduler.** You can multithread, but you have nothing that diverts your
  attention to the right thread at the right interval to keep work moving.
- **Isolated agents.** Each session is amnesiac and walled off — it relearns from scratch
  and can't benefit from what a sibling thread already figured out, even when they inform
  one another.
- **Scattered knowledge.** Skills, learnings, patterns, and rules are smeared across
  agents, repos, and threads, with no shared place they accrue.
- **No single surface.** There's no one place to see and move every moving piece of your
  local work.

## The idea

Owner Operator is the surface that sits **above** all your agents and **below** your
attention. Three things make it work:

- **Triage & prioritization.** It reads across every session and ranks what to touch next
  by urgency and how much attention each needs — the leaves, not the transcripts. *"This
  thread is here; act now, or it can wait?"*
- **An interrupt scheduler.** It watches the situation and nudges you to the right thread
  at the right time — *"this branch is lagging," "you committed to this PR in standup"* —
  so your attention goes where it's most valuable instead of round-robin.
- **A shared memory layer.** Keywords, learnings, patterns, and rules live in one durable
  place agents and threads can draw on, so context is recovered instead of relearned and
  one thread's discovery is available to the next.

**The loop:** `glance → drill into the right thread → drop a prompt → pull back up`. A
mobile/widget glance for when you're in the zone; a localhost UI for when you want to read
deeply.

## Principles

1. **Local-first.** Runs in the local context of your machine and leverages the tools
   already there. It can see across all your work, so it stays on your machine.
2. **Most-valuable-next.** Everything serves one question: what is the highest-value thing
   to work on right now?
3. **High signal, low noise.** Surfaces show the state of each thread, never raw
   transcripts. Depth is one drill away.
4. **One surface.** A single agentic control surface for every moving piece — as
   frictionless as possible.

## Components

1. **Harness "PI"** — the agentic core. Runs locally with a strict command set,
   deterministic workflow scripts, and scheduling to *"monitor the situation."* It
   bootstraps the cross-agent read from the [`ai-sessions` MCP](https://) (Claude Code,
   Codex, Gemini CLI, opencode, Copilot CLI, …). → [`harness/`](harness/)
2. **macOS widget** — always-there, glanceable triage. Threads from today, ongoing
   threads, prioritized. One panel to drop a prompt to the right agent.
   → [`apps/widget/`](apps/widget/)
3. **localhost web UI** — drill into a session, see exactly where it left off, read-first.
   Later: diff review with inline comments (Conductor-style). → [`apps/web/`](apps/web/)

## Roadmap

- **V1 — Read & triage.** Cross-section session list via `ai-sessions`, a prioritized
  "what's ongoing" view, drill-down read in the web UI, and the widget glance. Search and
  keyword breadcrumbs across sessions. Scheduled "monitor the situation" briefs.
  *V1 is read-only by design — the operator reads and organizes; it never drives a session
  or ghost-writes into a branch.*
- **V2 — Write & direct.** Drop prompts into sessions from the surface and issue explicit
  directions. No telephone game — when you write, it's *your* prompt to *that* branch, not
  an intermediary re-driving your sub-agents.
- **V3 — Memory, diff & integrate.** The shared memory layer agents draw on. Inline diff
  review tied to lines. Daily-brief ingestion from your code host (PRs/MRs), Slack, email,
  and calendar. Proactive nudges.

## Non-goals

- Not an autonomous orchestrator that runs your agents for you.
- Not a replacement for the agents — it's the layer that makes a **fleet** of them
  legible, prioritized, and connected.
</content>
</invoke>
