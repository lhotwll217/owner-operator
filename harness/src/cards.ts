// Owner Operator — thread card rendering. Kept separate from tui.ts so it can be unit-
// previewed without a live terminal. Produces the lines for one compact, glanceable card.

import { visibleWidth, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { PresentedThread } from "./agent";

type Styler = (s: string) => string;
const sgr = (...c: number[]): Styler => (s) => `\x1b[${c.join(";")}m${s}\x1b[0m`;
const dim = sgr(2), bold = sgr(1), cyan = sgr(36), yellow = sgr(33), green = sgr(32), red = sgr(1, 31);

// Priority color: 5 is loudest, 1 fades out. Drives the badge and the card's left rail.
export const prioColor = (p: number): Styler => (p >= 5 ? red : p === 4 ? yellow : p === 3 ? cyan : dim);

const MAX_W = 96;   // don't stretch across an ultra-wide terminal
const RAIL = 2;     // "▌ "
const INDENT = 4;   // body sits under the topic (after "P5  ")

// Compact card: a priority-colored left rail, then info grouped top→down the way you read
// it — what & how-fresh, where, state, next action. ANSI-aware widths so color never
// breaks alignment.
export function buildCard(t: PresentedThread, width: number): string[] {
  const W = Math.max(40, Math.min(width, MAX_W));
  const color = prioColor(t.priority);
  const rail = color("▌") + " ";
  const sub = color("▌") + " ".repeat(1 + INDENT); // rail + indent for body lines
  const bodyW = W - RAIL - INDENT;
  const out: string[] = [];

  // Line 1 — priority + topic (left), freshness (right).
  const badge = bold(color(`P${t.priority}`)) + "  ";
  const right = dim(t.lastActive);
  let head = badge + bold(t.topic);
  const headRoom = W - RAIL - visibleWidth(right) - 1;
  if (visibleWidth(head) > headRoom) head = truncateToWidth(head, headRoom);
  const gap = Math.max(1, W - RAIL - visibleWidth(head) - visibleWidth(right));
  out.push(rail + head + " ".repeat(gap) + right);

  // Line 2 — where: repo · app.
  out.push(sub + `${green(t.repo)}${dim(" · ")}${cyan(t.app)}`);

  // Line 3+ — state (summary), wrapped.
  for (const seg of wrapTextWithAnsi(t.summary, bodyW)) out.push(sub + seg);

  // Next action — arrow-led, continuation aligned under the text.
  const segs = wrapTextWithAnsi(t.nextSteps, bodyW - 2);
  segs.forEach((seg, i) => out.push(sub + (i === 0 ? cyan("→ ") + bold(seg) : "  " + seg)));

  return out;
}

// Headless/non-TTY block: priority-sorted cards separated by a blank line (returns ANSI
// lines; callers strip color when piping). Empty → a single notice. This is the same payload
// the TUI renders as live cards — one source of truth, surface-appropriate output.
export function buildCardsBlock(threads: PresentedThread[], width: number): string[] {
  if (!threads.length) return [dim("(no active threads)")];
  const sorted = [...threads].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0)); // loudest first
  const out: string[] = [];
  for (const t of sorted) out.push(...buildCard(t, width), "");
  return out;
}
