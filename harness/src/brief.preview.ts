// Deterministic test of the BRIEF RENDERER only (not the agent). No model, no TTY.
//   npm run preview:brief   (from harness/)
// Feeds fixed SidebarThread data into buildBrief() and asserts the rendering invariants
// (headline counts match the data, only needs-you threads are surfaced, the sidebar-remainder
// footer, the empty/all-clear cases). The full card renderer is covered by cards.preview.ts.

import assert from "node:assert";
import { buildBrief } from "./brief";
import type { SidebarThread } from "@owner-operator/core";

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

// Minimal SidebarThread factory — only the fields buildBrief reads, plus the ThreadStatus
// shape it extends. `t` ascends from oldest so lastMessageAt ordering is deterministic.
let t = 0;
const iso = (): string => new Date(1700000000000 + t++ * 60000).toISOString();
function row(p: Partial<SidebarThread> & Pick<SidebarThread, "repo" | "state">): SidebarThread {
  const at = iso();
  return {
    id: p.id ?? `${p.repo}-${t}`,
    source: "claude",
    repo: p.repo,
    app: p.app ?? "Claude CLI",
    topic: p.topic ?? "raw scan topic",
    state: p.state,
    lastActive: p.lastActive ?? "just now",
    createdAt: at,
    lastMessageAt: at,
    firstSeen: at,
    stateSince: at,
    active: p.active ?? true,
    triagedTopic: p.triagedTopic,
    summary: p.summary,
    nextSteps: p.nextSteps,
    priority: p.priority,
  };
}

// 6 active threads across 3 projects — 2 need you, 3 working, 1 idle.
const sample: SidebarThread[] = [
  row({ repo: "insights", state: "idle", topic: "data refresh" }),
  row({ repo: "amplify", state: "working", topic: "test sweep" }),
  row({ repo: "owner-operator", state: "working", topic: "daemon poll" }),
  row({ repo: "insights", state: "working", topic: "csv extract" }),
  row({ repo: "amplify", state: "needs-you", priority: 3, nextSteps: "paste the drafted 422 reply", summary: "contract mismatch resolved" }),
  row({ repo: "owner-operator", state: "needs-you", priority: 5, nextSteps: "review the diff & push", summary: "headless triage cards landed" }),
];

const width = 64;
const block = buildBrief(sample, width).map(stripAnsi);
process.stdout.write(block.join("\n") + "\n");

// --- invariants (fail loud on regression) ---
const head = block[0];
assert.match(head, /^▸ 6 threads across 3 projects/, "headline counts threads + projects from the data");
assert.ok(/2 need you/.test(head) && /3 working/.test(head) && /1 idle/.test(head), "headline shows the state mix");
assert.ok(block.some((l) => /^\s+Needs you now:/.test(l)), "a focus section for the waiting threads");
const focus = block.filter((l) => /^\s+• /.test(l));
assert.equal(focus.length, 2, "only the two needs-you threads are surfaced (not all six)");
assert.match(focus[0], /owner-operator — review the diff & push\s+P5/, "loudest needs-you first, with repo · action · priority");
assert.match(focus[1], /amplify — paste the drafted 422 reply\s+P3/, "second needs-you next");
assert.ok(block.some((l) => /Everything else is in the sidebar/.test(l)), "points at the sidebar for the working/idle remainder");

// all-clear: actives, but none need you → no card wall, just an all-clear line
const clear = buildBrief([row({ repo: "amplify", state: "working" }), row({ repo: "insights", state: "idle" })], width).map(stripAnsi);
assert.ok(clear.some((l) => /Nothing needs you right now/.test(l)), "no needs-you → all-clear, not a list");
assert.ok(!clear.some((l) => /^\s+• /.test(l)), "all-clear has no focus rows");

// empty: same notice the sidebar shows
assert.deepEqual(buildBrief([], width).map(stripAnsi), ["(no active threads)"], "empty → notice");

// cap: 5 needs-you → 4 shown + a surfaced overflow count (never a silent cap)
const many = Array.from({ length: 5 }, (_, i) => row({ repo: `r${i}`, state: "needs-you", priority: 3, nextSteps: `do ${i}` }));
const capped = buildBrief(many, width).map(stripAnsi);
assert.equal(capped.filter((l) => /^\s+• [^+]/.test(l)).length, 4, "caps inline focus at 4");
assert.ok(capped.some((l) => /\+1 more waiting/.test(l)), "overflow needs-you count is surfaced");

process.stdout.write("\nok — brief rendering preview passed\n");
