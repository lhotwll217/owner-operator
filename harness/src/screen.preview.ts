// Deterministic test of the FIXED-VIEWPORT layout — no TTY. Guards the invariants the pinned
// rail depends on: the frame is exactly `rows` tall, no line exceeds `columns`, the body is a
// real [ rail │ chat ] split, and the editor (with its cursor marker) is never clipped.
//   npx tsx src/screen.preview.ts   (from harness/)

import assert from "node:assert";
import { type Component } from "@earendil-works/pi-tui";
import { Screen, Columns, ChatPane } from "./screen";
import { SidebarList } from "./sidebar";
import { toSidebarThreads, type StatusSnapshot, type TriageInfo } from "@owner-operator/core";

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
const stub = (lines: string[]): Component => ({ render: () => lines, invalidate() {} });

const ROWS = 30, COLS = 100, RAIL_W = 34;
const NOW = "2026-06-09T12:00:00.000Z";

// rail data: the live poll snapshot enriched by the triage cache
const snap: StatusSnapshot = {
  polledAt: NOW,
  threads: [
    { id: "n", source: "claude", repo: "amplify", app: "Claude Code", topic: "raw 422", state: "needs-you", lastActive: "7 minutes ago", createdAt: NOW, lastMessageAt: NOW, firstSeen: NOW, stateSince: NOW },
    { id: "w", source: "claude", repo: "owner-operator", app: "Claude Code", topic: "status sidebar wiring", state: "working", lastActive: "just now", createdAt: NOW, lastMessageAt: NOW, firstSeen: NOW, stateSince: NOW },
  ],
};
const triage = new Map<string, TriageInfo>([["n", { topic: "422 contract mismatch", nextSteps: "Paste the drafted reply", priority: 5 }]]);

const rail = new SidebarList();
rail.setThreads(toSidebarThreads(snap, triage));

const chat = new ChatPane(stub(Array.from({ length: 50 }, (_, i) => `chat line ${i}`)));
const columns = new Columns(rail, chat, RAIL_W, 90);
const header = stub(["\x1b[1;35m● Owner Operator\x1b[0m", "local chief of staff · ctrl+t rail · ctrl+c exit"]);
const editor = stub(["", "› type here <CURSOR_SENTINEL>", ""]);
const screen = new Screen({ rows: ROWS, columns: COLS }, header, columns, editor);

const lines = screen.render(COLS);
for (const l of lines) process.stdout.write(stripAnsi(l).replace(/\s+$/, "") + "\n");

// --- the pinning invariant: exactly `rows` tall, nothing exceeds `columns` ---
assert.equal(lines.length, ROWS, "frame is exactly terminal rows tall (so pi-tui redraws in place)");
for (const l of lines) assert.ok(stripAnsi(l).length <= COLS, "no line exceeds terminal columns (no width crash)");

// --- header on top, editor (with cursor marker) at the bottom, never clipped ---
assert.match(stripAnsi(lines[0]), /● Owner Operator/, "header first");
assert.ok(stripAnsi(lines[ROWS - 2]).includes("<CURSOR_SENTINEL>"), "editor + cursor marker preserved at the bottom");

// --- body is a real split: separator column at RAIL_W, rail left, chat right ---
const body = lines.slice(2, ROWS - 3); // between 2-line header and 3-line editor
assert.equal(body.length, ROWS - 5, "body fills the rest of the viewport");
for (const l of body) {
  assert.equal(stripAnsi(l).length, COLS, "body lines are full width");
  assert.equal(stripAnsi(l)[RAIL_W], "│", "separator sits at the rail boundary");
}
assert.match(stripAnsi(body[0]).slice(0, RAIL_W), /Threads\s+2/, "rail header on the left");
assert.ok(body.some((l) => /chat line/.test(stripAnsi(l).slice(RAIL_W + 1))), "chat content on the right");
assert.ok(body.some((l) => /↑ \d+ earlier/.test(stripAnsi(l))), "chat tail shows the earlier-lines affordance");

// --- narrow terminal: rail hides, chat goes full width ---
assert.equal(columns.splits(80), false, "below splitMin the screen doesn't split");

process.stdout.write("\nok — fixed-viewport screen preview passed\n");
