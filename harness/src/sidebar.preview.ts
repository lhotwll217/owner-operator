// Deterministic test of the SIDEBAR — no poll, no model, no TTY.
//   npm run preview:sidebar   (from harness/)
// The sidebar = the LIVE poll snapshot enriched by the triage cache. Threads with status
// `done` leave the body but stay in the ✓ count.
// Asserts: numbered rows 1…n in display order (the /done handles), uniform rows (num · glyph ·
// priority · title · recency · grey next-step), triaged + untriaged both render, no cursor.

import assert from "node:assert";
import { visibleWidth } from "@earendil-works/pi-tui";
import { SidebarList } from "./sidebar";
import { toSidebarThreads, numberThreads, type StatusSnapshot, type ThreadStatus, type TriageInfo } from "@owner-operator/core";

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
const NOW = "2026-06-09T12:00:00.000Z";

const st = (id: string, repo: string, state: ThreadStatus["state"], topic: string, age: string, over: Partial<ThreadStatus> = {}): ThreadStatus =>
  ({ id, source: "claude", repo, app: "Claude CLI", topic, state, lastActive: age, createdAt: NOW, lastMessageAt: NOW, firstSeen: NOW, stateSince: NOW, ...over });

const snap: StatusSnapshot = {
  polledAt: NOW,
  threads: [
    st("n", "billing", "needs-you", "raw 422 topic", "7 minutes ago", { app: "Superset App", diffAdded: 12, diffDeleted: 4 }),
    st("w", "billing", "working", "Weekly update automation", "3 hours ago"),
    st("o", "owner-operator", "working", "status sidebar wiring", "just now", { app: "Cursor" }),
    st("old", "billing", "idle", "ancient idle thread", "2 days ago"), // NOT filtered — must show
    st("d", "billing", "done", "already shipped thing", "1 hour ago"),
  ],
};
const triage = new Map<string, TriageInfo>([
  ["n", { topic: "422 contract mismatch", nextSteps: "Paste the drafted reply", priority: 5 }],
  ["o", { nextSteps: "Push the fix", priority: 3 }],
]);

const rows = toSidebarThreads(snap, triage);
const panel = new SidebarList(20);
panel.setThreads(rows);
const lines = panel.render(51).map(stripAnsi);
process.stdout.write(lines.map((l) => "  " + l).join("\n") + "\n\n");

assert.match(lines[0], /^Threads\s+4/, "active threads shown — done row left the body");
assert.match(lines[1], /◐ 1.*● 2.*○ 1.*✓ 1/, "stats by state — done stays in the ✓ count");
assert.ok(!lines.some((l) => /already shipped/.test(l)), "/done'd row is gone from the body");
assert.ok(lines.some((l) => /^▾ billing\s+3/.test(l)), "grouped by project with per-group count");
assert.ok(lines.some((l) => /1 ◐ P5 422 contract mismatch.*7m$/.test(l)), "numbered triaged row: num · glyph · P-badge · title · recency");
assert.ok(lines.some((l) => /\d [●○] ancient idle thread/.test(l)), "untriaged idle thread still shows (raw topic, no badge)");
assert.ok(!lines.some((l) => /^→ /.test(l)), "no selection cursor (glance-only)");
assert.ok(lines.some((l) => /→ Paste the drafted reply/.test(l)) && lines.some((l) => /→ Push the fix/.test(l)), "next-step on every triaged row");

// --- the origin row: git ±delta (when the workspace has one) + the app, right-aligned ---
assert.ok(lines.some((l) => /\+12 -4  Superset App$/.test(l)), "delta sits just left of the app, right-aligned");
assert.ok(lines.some((l) => /^\s+Cursor$/.test(l)), "app-only origin row when there is no delta");
assert.equal(lines.filter((l) => /(Superset App|Cursor|Claude CLI)\s*$/.test(l)).length, 4, "every active row carries its origin");

// --- the numbering IS the /done handle: display order 1…n, resolved by the same core fn ---
const { byNum } = numberThreads(rows);
assert.equal(byNum.size, 4, "every active row numbered");
const numbered = lines.filter((l) => /^\s*\d [◐●○⠋]/.test(l));
assert.deepEqual(numbered.map((l) => Number(l.trim()[0])), [1, 2, 3, 4], "rows render 1…n in display order");
assert.equal(byNum.get(1)!.id, "n", "number 1 = the loudest displayed row");

// --- wrapping: the title caps at 2 lines (ellipsized); the next-step still keeps every word ---
const longTopic = "Reconsider the JSON output shape for agent-to-agent consumption and lifecycle state";
const longStep = "Decide whether JSON should emit a focused brief or the full lossless thread list";
const wrapSnap: StatusSnapshot = { polledAt: NOW, threads: [st("L", "owner-operator", "needs-you", longTopic, "2 minutes ago")] };
const wrapTriage = new Map<string, TriageInfo>([["L", { nextSteps: longStep, priority: 4 }]]);
const wpanel = new SidebarList(20);
wpanel.setThreads(toSidebarThreads(wrapSnap, wrapTriage));
const wlines = wpanel.render(51).map(stripAnsi);
process.stdout.write(wlines.map((l) => "  " + l).join("\n") + "\n\n");
const haystack = wlines.join(" ").replace(/\s+/g, " ");
// The title = the glyph row + the lines up to the "→" next-step. Capped at 2 lines total (1 + 1).
const rowIdx = wlines.findIndex((l) => /Reconsider/.test(l));
const stepIdx = wlines.findIndex((l) => /^\s*→/.test(l));
assert.ok(rowIdx >= 0 && stepIdx > rowIdx, "row and next-step rendered");
assert.equal(stepIdx - rowIdx, 2, "the title is the row + exactly one continuation (2 lines)");
assert.ok(wlines.some((l) => /…$/.test(l)), "an over-long title is ellipsized, not wrapped forever");
for (const w of longTopic.split(" ").slice(0, 4)) assert.ok(haystack.includes(w), `the start of the title survives ("${w}")`);
// The next-step is NOT capped — it still keeps every word (the sidebar must not drop the action).
for (const w of longStep.split(" ")) assert.ok(haystack.includes(w), `next-step word "${w}" survives the wrap`);
assert.ok(wlines.every((l) => visibleWidth(l) <= 51), "every wrapped line fits the column width");

// --- scrolling: when threads overflow a short sidebar, the window pages through them (Shift+↑/↓) ---
const tall = new SidebarList(7); // a short body → the 4-thread digest overflows it
tall.setThreads(rows);
const atTop = tall.render(51).map(stripAnsi);
assert.ok(!atTop.some((l) => /↑ \d+ more/.test(l)), "at the top: no upward marker");
assert.ok(atTop.some((l) => /↓ \d+ more/.test(l)), "overflow shows a downward marker");
assert.ok(!atTop.some((l) => /Push the fix/.test(l)), "the last group sits below the fold at the top");

tall.scroll(20); // page down past the middle (clamped to the content height at render)
const lower = tall.render(51).map(stripAnsi);
assert.ok(lower.some((l) => /↑ \d+ more/.test(l)), "after scrolling down: an upward marker appears");
assert.notEqual(lower.join("\n"), atTop.join("\n"), "the visible window actually moved");
assert.ok(lower.some((l) => /Push the fix|owner-operator/.test(l)), "scrolling down reveals the last group");

tall.scroll(-100); // back above the top → clamps to 0, identical to where we started
assert.equal(tall.render(51).map(stripAnsi).join("\n"), atTop.join("\n"), "scrolling back up clamps to the top");

// --- empty ---
const empty = new SidebarList().render(51).map(stripAnsi);
assert.match(empty[0], /^Threads\s+0/, "empty header");
assert.ok(empty.some((l) => /no active threads/.test(l)), "empty notice");

process.stdout.write("ok — sidebar preview passed\n");
