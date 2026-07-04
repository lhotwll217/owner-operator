// Deterministic test of the FIXED-VIEWPORT layout — no TTY. Guards the invariants the pinned
// sidebar depends on: the frame is exactly `rows` tall, no line exceeds `columns`, the body is a
// TRUE [ sidebar │ chat+editor ] split — the sidebar spans the full body height, the editor lives
// inside the right column (never under the sidebar), and its cursor marker is never clipped.
//   npx tsx src/screen.preview.ts   (from harness/)

import assert from "node:assert";
import { type Component } from "@earendil-works/pi-tui";
import { Screen, Columns, ChatPane } from "./screen";
import { SidebarList } from "./sidebar";
import { toSidebarThreads, type StatusSnapshot, type TriageInfo } from "@owner-operator/core";

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
const stub = (lines: string[]): Component => ({ render: () => lines, invalidate() {} });

const ROWS = 30, COLS = 130, SIDEBAR_CAP = 51, SIDEBAR_W = 51; // at 130 cols, 40% = 52 → capped at 51
const NOW = "2026-06-09T12:00:00.000Z";

// sidebar data: the live poll snapshot enriched by the triage cache
const snap: StatusSnapshot = {
  polledAt: NOW,
  threads: [
    { id: "n", source: "claude", repo: "billing", app: "Claude CLI", topic: "raw 422", state: "needs-you", lastActive: "7 minutes ago", createdAt: NOW, lastMessageAt: NOW, firstSeen: NOW, stateSince: NOW },
    { id: "w", source: "claude", repo: "owner-operator", app: "Claude CLI", topic: "status sidebar wiring", state: "working", lastActive: "just now", createdAt: NOW, lastMessageAt: NOW, firstSeen: NOW, stateSince: NOW },
  ],
};
const triage = new Map<string, TriageInfo>([["n", { topic: "422 contract mismatch", nextSteps: "Paste the drafted reply", priority: 5 }]]);

const sidebar = new SidebarList();
sidebar.setThreads(toSidebarThreads(snap, triage));

const chat = new ChatPane(stub(Array.from({ length: 50 }, (_, i) => `chat line ${i}`)));
const editor = stub(["", "› type here <CURSOR_SENTINEL>", ""]);
const columns = new Columns(sidebar, chat, editor, SIDEBAR_CAP, 80);
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
  assert.equal(stripAnsi(l)[SIDEBAR_W], "│", "separator sits at the sidebar boundary on EVERY body row");
}
assert.ok(stripAnsi(lines[ROWS - 2]).indexOf("<CURSOR_SENTINEL>") > SIDEBAR_W, "editor is inside the right column — not under the sidebar");
assert.match(stripAnsi(body[0]).slice(0, SIDEBAR_W), /Threads\s+2/, "sidebar header on the left");
assert.ok(body.some((l) => /chat line/.test(stripAnsi(l).slice(SIDEBAR_W + 1))), "chat content on the right");
assert.ok(body.some((l) => /↑ \d+ earlier/.test(stripAnsi(l))), "chat tail shows the earlier-lines affordance");

// --- responsive: on smaller windows the sidebar shrinks (40% of width) before it hides ---
assert.equal(columns.sidebarWidth(100), 40, "mid-size terminal → sidebar at 40% (under the cap)");
columns.setBodyHeight(20);
const mid = columns.render(100);
assert.equal(mid.length, 20, "mid-size body fills its height");
for (const l of mid) assert.equal(stripAnsi(l)[40], "│", "separator follows the responsive sidebar width");
assert.ok(mid[mid.length - 2].includes("<CURSOR_SENTINEL>"), "mid-size: editor still in the right column");

// --- narrow terminal: sidebar hides, chat + editor go full width ---
assert.equal(columns.splits(79), false, "below splitMin the screen doesn't split");
const narrow = columns.render(79);
assert.equal(narrow.length, 20, "narrow body still fills its height");
assert.ok(narrow[narrow.length - 2].includes("<CURSOR_SENTINEL>"), "narrow: editor at the bottom, full width");

// --- a pinned footer (the status bar) sits on the very last row, inside the frame ---
const withFooter = new Screen({ rows: ROWS, columns: COLS }, header, columns, stub(["ctx [████] 42%  ·  model"]));
const fl = withFooter.render(COLS);
assert.equal(fl.length, ROWS, "frame is still exactly rows tall with a footer");
assert.match(stripAnsi(fl[ROWS - 1]), /ctx \[████\] 42%/, "footer pinned on the last row");
assert.ok(fl.slice(0, ROWS - 1).some((l) => stripAnsi(l).includes("<CURSOR_SENTINEL>")), "editor (with cursor) sits above the footer");

// --- hide-sidebar toggle: chat goes full width with no separator (so a drag-select copies clean) ---
assert.ok(columns.splits(COLS), "sidebar shown by default on a wide terminal");
columns.toggleSidebar();
assert.equal(columns.splits(COLS), false, "toggle hides the sidebar even on a wide terminal");
columns.setBodyHeight(20);
const full = columns.render(COLS).map(stripAnsi);
assert.ok(!full.some((l) => l.includes("│")), "no separator while the sidebar is hidden — nothing to bleed into a copy");
assert.ok(!full.some((l) => /Threads\s+\d/.test(l)), "sidebar content gone");
assert.ok(full.some((l) => /chat line/.test(l)), "chat still renders");
assert.ok(full[full.length - 2].includes("<CURSOR_SENTINEL>"), "editor still at the bottom, full width");
columns.toggleSidebar(); // restore for any later use
assert.ok(columns.splits(COLS), "toggle brings the sidebar back");

// --- chat scrolling: follow the tail, page back into history, hold position as lines stream in ---
let chatLines = Array.from({ length: 50 }, (_, i) => `line ${i}`);
const growChat: Component = { render: () => chatLines, invalidate() {} };
const pane = new ChatPane(growChat);
pane.setHeight(10);

// follows the tail: newest line at the bottom, older hidden behind the top marker, no bottom marker
let v = pane.render(COLS).map(stripAnsi);
assert.equal(v.length, 10, "chat viewport is exactly its height");
assert.ok(v[v.length - 1].includes("line 49"), "follows the tail — newest line at the bottom");
assert.match(v[0], /↑ 40 earlier/, "older lines hidden behind the top marker");
assert.ok(!v.some((l) => /↓ \d+ more/.test(l)), "no bottom marker while following the tail");

// page up → into history; the latest scrolls out and a bottom marker shows how far from live
pane.scroll(-pane.pageStep());
v = pane.render(COLS).map(stripAnsi);
assert.ok(v.some((l) => /\bline 35\b/.test(l)), "page up reveals older lines");
assert.ok(!v.some((l) => /\bline 49\b/.test(l)), "the latest line scrolls out of view");
assert.match(v[v.length - 1], /↓ \d+ more/, "bottom marker appears once scrolled up");

// new lines stream in below while scrolled up → the reading position holds (no drift)
const beforeTop = v.find((l) => /\bline \d+\b/.test(l));
chatLines = [...chatLines, "line 50", "line 51", "line 52"];
const afterTop = pane.render(COLS).map(stripAnsi).find((l) => /\bline \d+\b/.test(l));
assert.equal(afterTop, beforeTop, "scrolled-up view holds its top line as content grows below it");

// jump back to the latest → following the tail again, bottom marker gone
pane.toBottom();
v = pane.render(COLS).map(stripAnsi);
assert.ok(v[v.length - 1].includes("line 52"), "toBottom returns to the latest line");
assert.ok(!v.some((l) => /↓ \d+ more/.test(l)), "no bottom marker once back at the tail");

// content shorter than the viewport → everything shows, nothing to scroll
const small = new ChatPane(stub(["a", "b", "c"]));
small.setHeight(10);
assert.deepEqual(small.render(COLS).map(stripAnsi), ["a", "b", "c"], "short content renders whole, unscrolled");

process.stdout.write("\nok — fixed-viewport screen preview passed\n");
