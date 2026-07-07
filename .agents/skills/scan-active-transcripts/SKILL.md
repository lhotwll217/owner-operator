---
name: scan-active-transcripts
description: >-
  Scan local CLI agent session transcripts for a compact digest — topic, resolved state,
  and a sample of each thread's opening + most-recent messages. Use when you need message
  content: filling in triage summaries, discovering threads, or drilling into one thread.
  Secondary to get-current-session-state, which owns membership.
allowed-tools: bash
---

# scan-active-transcripts

A deterministic script; you only read its small, pre-digested output — never load full
transcripts or read session files yourself.

For "what's ongoing" triage, `get-current-session-state` is the source of truth for
membership; this scan supplies the content. **Merge, never substitute:** a row the scan
misses (e.g. outside its window) stays in the triage — widen `--since` or drill in with
`--thread <id>`.

## How to use

```bash
node .agents/skills/scan-active-transcripts/scan-active-transcripts.mjs --since today --sample 4
```

Flags:
- `--since 24h | 7d | today | 2026-06-04` — window; rolling `Nh`/`Nd`, calendar `today`, or an ISO date. Default = the owner's `activeWindow` setting (rolling `1d` if unset)
- `--sample N` — keep the first N + most-recent N messages per thread (default 4; `--bookends`/`--last` are aliases)
- `--thread <id>` — drill into ONE thread (id prefix ok); pair with a bigger `--sample` to expand just that thread
- `--limit N` — max threads (default 40)
- `--all` — include automated/single-turn worker runs AND done threads (both hidden by default)
- `--include-done` — include threads the owner marked done (for auditing)
- `--json` — machine-readable output (use when you want to post-process)
- `--truncate N` — per-message char cap (default 280)

Session sources and their default roots are declared in `KNOWN_SESSION_SOURCES`
([`packages/core/src/session-sources.mjs`](../../../packages/core/src/session-sources.mjs));
owners relocate or disable them via `~/.owner-operator/session_sources.json` (format
documented there). Origin `App` names are canonical in
[`packages/core/src/gui-hosts.mjs`](../../../packages/core/src/gui-hosts.mjs).

Each thread carries a resolved `State` (needs-you / working / idle / done) — the scan's
candidates joined against the owner's status store by the canonical resolver. Done threads
are excluded by default and only reappear when a newer message wakes them (`--include-done`
audits; `--thread` always answers). A workspace with changes vs its base branch carries a
`Diff: +N -N` line. A PostHog Code thread with `environment: cloud` is provisioning/working
in a remote sandbox — call that out; it's progressing while the owner is away.

## Merge with current state

Reason over each thread's `firstMessages` + `recentMessages` and fill the tool's fields per
its schema; copy `id`, relative times, and diff numbers from the digest verbatim. Priority
= how much it needs the owner **now** (5 = waiting on a decision/approval/review; 1 =
ticking along). Don't resurrect done threads; never paste the raw tail. In normal `oo`
chat, answer in concise prose; `oo --session-state` is the model-free state snapshot for
scripts.

If a thread's ends are too vague to summarize, expand just that thread first —
`--thread <id> --sample 15` — then merge the result into the current-state rows.
