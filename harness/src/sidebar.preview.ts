// Deterministic test of the SIDEBAR rail — no poll, no model, no TTY.
//   npm run preview:sidebar   (from harness/)
// The rail = the LIVE poll snapshot (every thread, NO filter) enriched by the triage cache.
// Asserts: every thread shown (incl. idle/old), uniform rows (glyph · priority · title ·
// recency · grey next-step), triaged + untriaged both render, no selection cursor.

import assert from "node:assert";
import { SidebarList } from "./sidebar";
import { toSidebarThreads, type StatusSnapshot, type ThreadStatus, type TriageInfo } from "@owner-operator/core";

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
const NOW = "2026-06-09T12:00:00.000Z";

const st = (id: string, repo: string, state: ThreadStatus["state"], topic: string, age: string): ThreadStatus =>
  ({ id, source: "claude", repo, app: "Claude Code", topic, state, lastActive: age, createdAt: NOW, lastMessageAt: NOW, firstSeen: NOW, stateSince: NOW });

const snap: StatusSnapshot = {
  polledAt: NOW,
  threads: [
    st("n", "amplify", "needs-you", "raw 422 topic", "7 minutes ago"),
    st("w", "amplify", "working", "Weekly update automation", "3 hours ago"),
    st("o", "owner-operator", "working", "status sidebar wiring", "just now"),
    st("old", "amplify", "idle", "ancient idle thread", "2 days ago"), // NOT filtered — must show
  ],
};
const triage = new Map<string, TriageInfo>([
  ["n", { topic: "422 contract mismatch", nextSteps: "Paste the drafted reply", priority: 5 }],
  ["o", { nextSteps: "Push the fix", priority: 3 }],
]);

const panel = new SidebarList(20);
panel.setThreads(toSidebarThreads(snap, triage));
const lines = panel.render(34).map(stripAnsi);
process.stdout.write(lines.map((l) => "  " + l).join("\n") + "\n\n");

assert.match(lines[0], /^Threads\s+4/, "every polled thread shown — nothing filtered");
assert.match(lines[1], /◐ 1.*● 2.*○ 1/, "stats by state");
assert.ok(!lines.some((l) => /older/.test(l)), "no '+older' filtering");
assert.ok(lines.some((l) => /^▾ amplify\s+3/.test(l)), "grouped by project with per-group count");
assert.ok(lines.some((l) => /◐ P5 422 contract mismatch.*7m$/.test(l)), "triaged row: glyph · P-badge · title · recency");
assert.ok(lines.some((l) => /● ancient idle thread|○ ancient idle thread/.test(l)), "untriaged idle thread still shows (raw topic, no badge)");
assert.ok(!lines.some((l) => /^→ /.test(l)), "no selection cursor (glance-only)");
assert.ok(lines.some((l) => /→ Paste the drafted reply/.test(l)) && lines.some((l) => /→ Push the fix/.test(l)), "next-step on every triaged row");

// --- empty ---
const empty = new SidebarList().render(34).map(stripAnsi);
assert.match(empty[0], /^Threads\s+0/, "empty header");
assert.ok(empty.some((l) => /no active threads/.test(l)), "empty notice");

process.stdout.write("ok — sidebar rail preview passed\n");
