// Deterministic test of the FIXED-VIEWPORT layout — no TTY. Guards the invariants the pinned
// rail depends on: the frame is exactly `rows` tall, no line exceeds `columns`, the body is a
// TRUE [ rail │ chat+editor ] split — the rail spans the full body height, the editor lives
// inside the right column (never under the rail), and its cursor marker is never clipped.
//   npx tsx src/screen.preview.ts   (from harness/)

import assert from "node:assert";
import { type Component } from "@earendil-works/pi-tui";
import { Screen, Columns, ChatPane } from "./screen";
import { SidebarList } from "./sidebar";
import { toSidebarThreads, type StatusSnapshot, type TriageInfo } from "@owner-operator/core";

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
const stub = (lines: string[]): Component => ({ render: () => lines, invalidate() {} });

const ROWS = 30, COLS = 130, RAIL_CAP = 51, RAIL_W = 51; // at 130 cols, 40% = 52 → capped at 51
const NOW = "2026-06-09T12:00:00.000Z";

// rail data: the live poll snapshot enriched by the triage cache
const snap: StatusSnapshot = {
  polledAt: NOW,
  threads: [
    { id: "n", source: "claude", repo: "amplify", app: "Claude CLI", topic: "raw 422", state: "needs-you", lastActive: "7 minutes ago", createdAt: NOW, lastMessageAt: NOW, firstSeen: NOW, stateSince: NOW },
    { id: "w", source: "claude", repo: "owner-operator", app: "Claude CLI", topic: "status sidebar wiring", state: "working", lastActive: "just now", createdAt: NOW, lastMessageAt: NOW, firstSeen: NOW, stateSince: NOW },
  ],
};
const triage = new Map<string, TriageInfo>([["n", { topic: "422 contract mismatch", nextSteps: "Paste the drafted reply", priority: 5 }]]);

const rail = new SidebarList();
rail.setThreads(toSidebarThreads(snap, triage));

const chat = new ChatPane(stub(Array.from({ length: 50 }, (_, i) => `chat line ${i}`)));
const editor = stub(["", "› type here <CURSOR_SENTINEL>", ""]);
const columns = new Columns(rail, chat, editor, RAIL_CAP, 80);
const header = stub([
  "\x1b[1;37m ██████  ██     ██ ███    ██ ███████ ██████          ██      ██████  ██████  ███████ ██████   █████  ████████  ██████  ██████\x1b[0m",
  "\x1b[1;37m██    ██ ██     ██ ████   ██ ██      ██   ██        ██      ██    ██ ██   ██ ██      ██   ██ ██   ██    ██    ██    ██ ██   ██\x1b[0m",
  "\x1b[1;37m██    ██ ██  █  ██ ██ ██  ██ █████   ██████        ██       ██    ██ ██████  █████   ██████  ███████    ██    ██    ██ ██████\x1b[0m",
  "\x1b[1;37m██    ██ ██ ███ ██ ██  ██ ██ ██      ██   ██      ██        ██    ██ ██      ██      ██   ██ ██   ██    ██    ██    ██ ██   ██\x1b[0m",
  "\x1b[1;37m ██████   ███ ███  ██   ████ ███████ ██   ██     ██          ██████  ██      ███████ ██   ██ ██   ██    ██     ██████  ██   ██\x1b[0m",
  "local chief of staff · /done 1,3 · esc stop · ctrl+c exit",
]);
const screen = new Screen({ rows: ROWS, columns: COLS }, header, columns);

const lines = screen.render(COLS);
for (const l of lines) process.stdout.write(stripAnsi(l).replace(/\s+$/, "") + "\n");

// --- the pinning invariant: exactly `rows` tall, nothing exceeds `columns` ---
assert.equal(lines.length, ROWS, "frame is exactly terminal rows tall (so pi-tui redraws in place)");
for (const l of lines) assert.ok(stripAnsi(l).length <= COLS, "no line exceeds terminal columns (no width crash)");

// --- header on top, editor (with cursor marker) at the bottom of the RIGHT column ---
assert.match(stripAnsi(lines[0]), /██████ {2}██/, "wordmark header first");
assert.ok(stripAnsi(lines[ROWS - 2]).includes("<CURSOR_SENTINEL>"), "editor + cursor marker preserved at the bottom");

// --- a TRUE sidebar: the separator runs the FULL body height — including the editor rows ---
const body = lines.slice(6); // everything under the 6-line header
assert.equal(body.length, ROWS - 6, "body fills the rest of the viewport");
for (const l of body) {
  assert.equal(stripAnsi(l).length, COLS, "body lines are full width");
  assert.equal(stripAnsi(l)[RAIL_W], "│", "separator sits at the rail boundary on EVERY body row");
}
assert.ok(stripAnsi(lines[ROWS - 2]).indexOf("<CURSOR_SENTINEL>") > RAIL_W, "editor is inside the right column — not under the rail");
assert.match(stripAnsi(body[0]).slice(0, RAIL_W), /Threads\s+2/, "rail header on the left");
assert.ok(body.some((l) => /chat line/.test(stripAnsi(l).slice(RAIL_W + 1))), "chat content on the right");
assert.ok(body.some((l) => /↑ \d+ earlier/.test(stripAnsi(l))), "chat tail shows the earlier-lines affordance");

// --- responsive: on smaller windows the rail shrinks (40% of width) before it hides ---
assert.equal(columns.railWidth(100), 40, "mid-size terminal → rail at 40% (under the cap)");
columns.setBodyHeight(20);
const mid = columns.render(100);
assert.equal(mid.length, 20, "mid-size body fills its height");
for (const l of mid) assert.equal(stripAnsi(l)[40], "│", "separator follows the responsive rail width");
assert.ok(mid[mid.length - 2].includes("<CURSOR_SENTINEL>"), "mid-size: editor still in the right column");

// --- narrow terminal: rail hides, chat + editor go full width ---
assert.equal(columns.splits(79), false, "below splitMin the screen doesn't split");
const narrow = columns.render(79);
assert.equal(narrow.length, 20, "narrow body still fills its height");
assert.ok(narrow[narrow.length - 2].includes("<CURSOR_SENTINEL>"), "narrow: editor at the bottom, full width");

process.stdout.write("\nok — fixed-viewport screen preview passed\n");
