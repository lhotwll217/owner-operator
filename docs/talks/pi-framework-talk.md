# Mini Harnesses, Real Surfaces — Building Owner Operator on pi

Talk for Softlandia AI engineer consultants · ~25–30 min + Q&A
Repo: [owner-operator](https://github.com/lhotwll217/owner-operator) · Framework: [pi](https://github.com/earendil-works/pi)

**One-line thesis:** Stop wrapping chat. Build a *mini specialized harness* — your own
system prompt, a bounded toolset, deterministic skills, and a typed data contract — then
hang as many surfaces (TUI, web, widget, scripts) off that one contract as you like.

---

## Arc

1. The problem (2 min)
2. What Owner Operator does — demo (4 min)
3. The thesis: harness, not app (3 min)
4. The pi framework (5 min)
5. Approach 1 — start with a TUI to lock in the key information (5 min)
6. Approach 2 — deterministic skills, token discipline (4 min)
7. Approach 3 — one state owner (daemon / gateway pattern) (3 min)
8. Standing on shoulders — the inspiration dock (2 min)
9. Takeaways for consultants (2 min)

---

## 1. The problem (2 min)

- I run many CLI agent sessions in parallel — Claude Code, Codex, Cursor — each doing
  real implementation work. The "branches."
- The context lives in my head: which thread needs a one-word "yes, merge it" vs. a real
  plan review. Things slip ("I said I'd land this PR today").
- Context-switching is expensive **and uneven** — I need to know which thread needs me
  *without* paying the cost of opening each one.
- Crucially: I do **not** want an intermediary agent re-prompting my sub-agents. That
  degrades the work. When I write, I want to be *in* the branch.

> Slide: just the loop — `glance → drill into the right thread → drop YOUR prompt → pull back up`

## 2. What Owner Operator does (4 min) — DEMO

A local-first **chief of staff** for everything running on my machine. It reads,
organizes, and triages all my CLI agent sessions. It reads and organizes — **it never drives.**

**Demo beats** (live in terminal):

1. `oo "what needs me"` — one-shot: the agent runs the scan skill, triages, renders cards.
2. The branded TUI: pinned thread rail (status: working / needs-you / idle), chat pane,
   priority-sorted cards. Point out the rail updates from a model-free poll — no LLM call.
3. `oo --json "what needs me"` — same brain, headless JSON. *This is the punchline for
   later: the data is the product, the UI is a renderer.*
4. (Optional) the daemon: `curl localhost:47711/threads`, and a schedule —
   `PUT /schedules/morning-brief` with a daily shell action.

How it reads sessions: directly off disk — Claude Code (`~/.claude/projects`), Codex
(`~/.codex/sessions`), Cursor — with our own dependency-free scan/grep skills. No vendor
API, no hosted anything. Local-first.

**My core application primitives** (specialized building blocks everything hangs off):

- `Thread` / `Triage` — the typed contract every surface renders (`packages/core`)
- `present_threads` — structured triage as a tool call, never prose
- Scan/grep skills — `get-active-threads`, `sessions-grep`, `session-keywords`
- Status state machine + canonical resolver — `resolveState` / `reconcile` / `diffSnapshots`, model-free
- Daemon — one state owner: poll loop, schedules/triggers (WHEN × ACTION), HTTP+SSE
- Surfaces as thin renderers — CLI, TUI, `--json`; web + widget next

## 3. The thesis: harness, not app (3 min)

What I mean by a **mini specialized harness**:

| Piece | In Owner Operator |
|---|---|
| Own system prompt | `harness/prompts/owner-operator.md` — role, output rules, tool discipline |
| Bounded command set | read + triage only; it cannot author work or drive sessions |
| Deterministic skills | `get-active-threads`, `sessions-grep`, `session-keywords` — scripts, not model improvisation |
| Typed data contract | `packages/core` — `Thread`, `Triage`, the status state machine |
| N surfaces | plain CLI, branded TUI, `--json`, daemon HTTP+SSE; web + widget next |

- A general coding agent is general on purpose. Your *product* is the constraints: what
  it's allowed to do, what it must never do, and what shape its output takes.
- Pick a few **core application primitives**, specialized to the domain, and make them
  sharp — everything else hangs off them.

## 4. The pi framework (5 min)

- **[pi](https://github.com/earendil-works/pi)** — Mario Zechner's open-source coding
  agent *toolkit*. The key property: it's published as **npm libraries**, not just a CLI.
- We consume it as deps — **not a fork, not a submodule**:
  - `@earendil-works/pi-agent-core` — the agent loop we build the harness on
  - `@earendil-works/pi-ai` — unified LLM API (typed tool schemas via `Type.Object`)
  - `@earendil-works/pi-tui` — terminal UI components (Editor, Markdown, Box, Loader)
  - `@earendil-works/pi-coding-agent` — the full CLI when you want it (SessionManager,
    SettingsManager, AuthStorage, ModelRegistry — we reuse these instead of rebuilding)
- Pinned exact (pre-1.0, ships fast). This is exactly how **OpenClaw** — the largest
  pi-based product — does it: own repo, pi via npm. We copied the consumption pattern
  before writing a line.
- What you get for free vs. what you own: pi gives the agent loop, model plumbing,
  sessions, TUI toolkit; you own the prompt, the tools, the skills, the data contract,
  and the surfaces. All of this makes it quick to get a working demo up in a few hours.

> Slide: the architecture diagram from `docs/architecture.md` — surfaces on top, harness
> in the middle, scan skills + (later) signal sources below.

## 5. Approach 1 — start with a TUI to lock in the key information (5 min)

**The core argument of the talk.** The first surface's job is not to be pretty — it's to
force the question: *what is the key information, and what shape does it take?*

- A TUI is the cheapest real surface: no build step, no deploy, instant iteration, and
  you actually *live* in it daily — so the contract gets pressure-tested for real.
- The design work happens in the **schema**, not the pixels. Our `Thread` card
  (`packages/core/src/index.ts`):
  `topic · priority 1–5 · summary (≤15 words) · nextSteps · repo · app · created · lastActive · diff ±`
  Every one of those fields earned its place by me staring at the TUI and noticing what
  I actually needed to decide "touch this or not."
- **Structured output as a tool call, not prose.** The model doesn't write paragraphs —
  it calls `present_threads` with typed JSON (schema descriptions double as prompt
  engineering: "≤ ~15 words", "never repeat the repo name"). The surface renders cards.
- Once the contract is locked, every new surface is *just a renderer*: the plain CLI,
  `--json` for scripts, the web UI and macOS widget next — they all consume the same
  `Thread[]`. "Structured data is the product; UIs are renderers."

> Show side by side: the `ThreadCard` Type.Object schema vs. the rendered TUI card.
> Same payload → cards in the TUI, JSON headless, (soon) widget rows.

## 6. Approach 2 — deterministic skills, token discipline (4 min)

The hard-won lesson, verbatim from the agent's own instructions: session transcripts are
**huge** — letting the model read them overflows context and burns tokens.

- So **gathering is a deterministic script, not the model's job**. The
  `get-active-threads` skill scans session files and emits a compact digest (topic + a
  few-message tail per thread). The model only ever reads the digest.
- The prompt enforces it: "Do NOT read session files yourself." The skill is the only
  path to the data.
- General principle for client work: split every agent feature into
  **deterministic gather → small model judgment → typed output**. The model does the one
  thing only a model can do (triage/judgment); scripts do everything repeatable.
  Cheaper, faster, testable, and the failure modes are legible.
- Corollary: the TUI's thread rail never calls the LLM at all — it's a model-free poll
  over the same scan, with cached model triage merged in by id. Know which pixels need a
  model and which don't.

## 7. Approach 3 — one state owner (daemon / gateway pattern) (3 min)

Multi-surface immediately raises: who owns the state?

- Borrowed from OpenClaw's Gateway pattern, sized local-first: **one process owns
  state** — `oo daemon` runs the poll loop (scan → canonical resolver → store), the
  schedule/trigger runner, and HTTP + SSE on 127.0.0.1. Surfaces are thin clients;
  they query, never derive their own view of the world.
- Schedules are WHEN × ACTION, upserted over HTTP — a morning brief or a desktop
  notification on "thread newly needs you" is one `curl` away. The agentic version
  becomes a new action type when it's ready; the plumbing doesn't change.
- The TUI auto-spawns the daemon and degrades to an embedded poller if disabled —
  surfaces stay usable standalone.

## 8. Standing on shoulders — the inspiration dock (2 min)

We keep a living `docs/inspiration.md`: *list it · link it · what it is · what to borrow.*
Checked before building anything non-trivial; agents are instructed to add to it.

Concrete borrows:
- **OpenClaw** → gateway/state-owner pattern, pi-via-npm consumption
- **agent-deck** → the status state machine (`● working · ◐ needs-you · ○ idle · ✕ error`)
- **Superset** → "needs attention" monitor-and-notify state
- **clancey / constellos** → Claude Code JSONL parsing details (`isMeta` filtering,
  content-block extraction) — saved days of reverse-engineering
- **Conductor** → the UX north star for drill-in / diff review (V3)

Consulting angle: the doc itself is a deliverable pattern — it shows clients you survey
prior art before billing build hours.

## 9. Takeaways for consultants (2 min)

1. **Build harnesses, not wrappers.** Prompt + bounded tools + skills + typed contract.
   The constraints are the product.
2. **Focus on a few core application primitives** — specialized to the domain, made sharp.
3. **TUI first.** Cheapest surface that forces the real question: what's the key
   information? Lock the schema by living in it; surfaces after that are renderers.
4. **Deterministic gather, model judgment.** Scripts collect, the model decides, output
   is typed. Token bills and failure modes both shrink.
5. **One state owner.** The moment you have two surfaces, stand up the gateway. Don't
   let each surface derive its own truth.
6. **Keep an inspiration dock.** Borrow patterns shamelessly and write down what you
   borrowed — it compounds.

## Q&A seeds

- Why pi over the Claude Agent SDK / LangGraph? (npm-library granularity, TUI toolkit
  included, OpenClaw as the existence proof at scale)
- How do you keep the model from hallucinating fields? (schema descriptions as prompt,
  copy-verbatim instructions, digest provides ground truth)
- What breaks at V2 (write/direct)? (the read-only safety story — that's why it's a
  separate phase)

---

## Prep checklist

- [ ] Fresh sessions on the demo machine so `oo "what needs me"` has real threads
- [ ] Terminal font/size for projector; TUI rail legible at distance
- [ ] `curl` snippets for daemon + schedule demo in a scratch file
- [ ] Screenshot fallbacks if live demo dies
- [ ] Architecture diagram slide exported from `docs/architecture.md`
