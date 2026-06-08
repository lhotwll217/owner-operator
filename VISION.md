# Owner Operator — Vision

## One line

A local-first **chief of staff** for everything running on your machine. It reads,
organizes, and triages all of your CLI agent sessions and the signal around them
(PRs/MRs, Slack, email, calendar) so you can **glance → drill into the right thread →
drop a prompt → pull back up** — with minimal cognitive load, and without an
intermediary agent re-driving your work.

## The problem

- You run many agent sessions in parallel — the "branches" — across Claude Code,
  Codex, and friends. Each one is doing real implementation work.
- Your high-level "main chat" is great for **branching** and **reading**, but bad for
  **writing/directing**: you don't want an intermediary agent re-prompting your
  sub-agents, because that degrades the work. When you write, you want to be *in* the
  branch.
- You hold enormous context — standups, Slack threads you're tagged in, open PRs,
  emails — but it lives in your head. Things slip ("I said I'd land this PR today" →
  forgotten by EOD).
- Context-switching is expensive **and uneven**: some threads need a one-word "yes,
  merge it," others need a real plan review. You need to know which is which *without*
  paying the cost of opening each one.

## The idea

Owner Operator is the surface that sits **above** all your agents and **below** your
attention.

- **It reads and organizes — it does not drive.** It is *not* an intermediary that
  re-prompts your sub-agents. When you drill into a session and type, your input goes
  to *that* session as *your* prompt. The operator's job is reading, reporting,
  organizing, and prioritizing — never doing the writing for you. (V1 is read-only by
  design.)
- **High signal, low noise.** The top level shows the **leaves** — the ends of each
  branch: *"this thread is here; do you need to act, or can it wait?"* The details stay
  in the branch.
- **Rank what to touch next.** Order threads by urgency and how much attention each
  needs, and (later) nudge proactively on a schedule: *"this branch has been lagging,"*
  *"you committed to this PR in standup."*
- **Glance → drill → prompt → pull back up.** The core loop. A mobile/widget glance for
  when you're in the zone; a localhost UI for when you want to read deeply.

## Principles

1. **Local-first.** Runs in the local context of your machine and leverages the tools
   already there (your existing CLIs, Slack, email, calendar).
2. **No telephone game.** The operator never ghost-writes into a branch. Drilling in
   puts *you* in the driver's seat — your prompt, your branch.
3. **Concise above all.** The operator is terse and high-signal; verbosity lives in the
   branches.
4. **Read before write.** V1 reads and triages. Writing and direction come once the
   reading is trustworthy.
5. **Conductor is the closest UX reference** (diff view, comment-on-diff tied to lines)
   — but with a triage/prioritization layer on top, not just session management.

## Components

1. **Harness "PI"** — the agentic core. Runs locally with a **strict command set**,
   deterministic workflow scripts, and scheduling to *"monitor the situation."* It
   bootstraps the cross-agent read with our own dependency-free scan/grep skills over the
   local session files (Claude Code, Codex today; more sources as skills land).
   → [`harness/`](harness/)
2. **macOS widget** — always-there, glanceable triage. Threads started today, ongoing
   threads, prioritized. One panel to drop a prompt to the right agent.
   → [`apps/widget/`](apps/widget/)
3. **localhost web UI** — drill into a session, see exactly where it left off, read
   level first. Later: diff review with inline comments (Conductor-style), possibly via
   draft PRs to start. → [`apps/web/`](apps/web/)

## Roadmap

- **V1 — Read & triage.** Cross-section session list via our own scan/grep skills over local session files. A prioritized
  "what's ongoing" view. Drill-down read in the web UI. Widget glance. Harness with
  strict *read* commands + scheduled "monitor the situation" briefs.
- **V2 — Write & direct.** Drop prompts into sessions from the surface. Issue explicit
  directions ("merge this PR, the comments are addressed"). Still no telephone game —
  your prompt, your branch.
- **V3 — Diff & integrate.** Inline diff review tied to lines. Daily-brief ingestion
  from your code host (PRs/MRs, QA), Slack (tags), email, and calendar. Proactive nudges.

## Non-goals

- Not an autonomous orchestrator that runs your agents for you.
- Not a replacement for the agents — it's the layer that makes a **fleet** of them
  legible and prioritized.
