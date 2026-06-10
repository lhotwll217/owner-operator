// Deterministic test of the SIDEBAR rail — no poll, no model, no TTY.
//   npm run preview:sidebar   (from harness/)
// The rail = the LIVE poll snapshot (every thread, NO filter) enriched by the triage cache,
// minus the done overlay (/done): marked rows leave the body but stay in the ✓ count.
// Asserts: numbered rows 1…n in display order (the /done handles), uniform rows (num · glyph ·
// priority · title · recency · grey next-step), triaged + untriaged both render, no cursor.

import assert from "node:assert";
import { SidebarList } from "./sidebar";
import { toSidebarThreads, numberThreads, type StatusSnapshot, type ThreadStatus, type TriageInfo } from "@owner-operator/core";

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
    st("d", "amplify", "needs-you", "already shipped thing", "1 hour ago"), // /done'd — leaves the body
  ],
};
const triage = new Map<string, TriageInfo>([
  ["n", { topic: "422 contract mismatch", nextSteps: "Paste the drafted reply", priority: 5 }],
  ["o", { nextSteps: "Push the fix", priority: 3 }],
]);
const done = new Map([["d", "2026-06-09T13:00:00.000Z"]]); // marked AFTER its last message → inactive

const rows = toSidebarThreads(snap, triage, done);
const panel = new SidebarList(20);
panel.setThreads(rows);
const lines = panel.render(51).map(stripAnsi);
process.stdout.write(lines.map((l) => "  " + l).join("\n") + "\n\n");

assert.match(lines[0], /^Threads\s+4/, "active threads shown — done row left the body");
assert.match(lines[1], /◐ 1.*● 2.*○ 1.*✓ 1/, "stats by state — done stays in the ✓ count");
assert.ok(!lines.some((l) => /already shipped/.test(l)), "/done'd row is gone from the body");
assert.ok(lines.some((l) => /^▾ amplify\s+3/.test(l)), "grouped by project with per-group count");
assert.ok(lines.some((l) => /1 ◐ P5 422 contract mismatch.*7m$/.test(l)), "numbered triaged row: num · glyph · P-badge · title · recency");
assert.ok(lines.some((l) => /\d [●○] ancient idle thread/.test(l)), "untriaged idle thread still shows (raw topic, no badge)");
assert.ok(!lines.some((l) => /^→ /.test(l)), "no selection cursor (glance-only)");
assert.ok(lines.some((l) => /→ Paste the drafted reply/.test(l)) && lines.some((l) => /→ Push the fix/.test(l)), "next-step on every triaged row");

// --- the numbering IS the /done handle: display order 1…n, resolved by the same core fn ---
const { byNum } = numberThreads(rows);
assert.equal(byNum.size, 4, "every active row numbered");
const numbered = lines.filter((l) => /^\s*\d [◐●○⠋]/.test(l));
assert.deepEqual(numbered.map((l) => Number(l.trim()[0])), [1, 2, 3, 4], "rows render 1…n in display order");
assert.equal(byNum.get(1)!.id, "n", "number 1 = the loudest displayed row");

// --- empty ---
const empty = new SidebarList().render(51).map(stripAnsi);
assert.match(empty[0], /^Threads\s+0/, "empty header");
assert.ok(empty.some((l) => /no active threads/.test(l)), "empty notice");

process.stdout.write("ok — sidebar rail preview passed\n");
