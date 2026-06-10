// Owner Operator — fixed-viewport layout. pi-tui is inline/scrollback: it only redraws in
// place (no native-scrollback growth) when the whole frame is <= terminal rows. So the rail
// can only stay pinned if we render a bounded frame every tick. `Screen` enforces that
// (header + body, always <= rows); `Columns` is the manual [ rail │ chat-over-editor ] split
// (pi-tui has no columns primitive) — a TRUE sidebar: the rail spans the full body height and
// the editor lives INSIDE the right column, so the input never runs under the rail;
// `ChatPane` bounds the growing chat to its tail.

import { visibleWidth, truncateToWidth, type Component } from "@earendil-works/pi-tui";

const dim = (s: string): string => `\x1b[2m${s}\x1b[0m`;

/** Pad or truncate a (possibly ANSI) line to an exact visible width. */
const padExact = (line: string, w: number): string => {
  const vis = visibleWidth(line);
  if (vis === w) return line;
  return vis < w ? line + " ".repeat(w - vis) : truncateToWidth(line, w);
};
/** Force an array to exactly `h` lines (pad with blanks, clip the overflow). */
const toLines = (lines: string[], h: number): string[] => {
  const out = lines.slice(0, h);
  while (out.length < h) out.push("");
  return out;
};

/** Bounded viewport over the (growing) chat content: shows the last `height` lines. */
export class ChatPane implements Component {
  private height = 20;
  constructor(private readonly child: Component) {}
  setHeight(h: number): void { this.height = Math.max(1, h); }
  invalidate(): void { this.child.invalidate(); }
  render(width: number): string[] {
    const lines = this.child.render(width);
    if (lines.length <= this.height) return lines;
    const tail = lines.slice(lines.length - this.height);
    tail[0] = dim(`  ↑ ${lines.length - this.height} earlier`);
    return tail;
  }
}

/** The left column must accept a body height. */
export interface RailComponent extends Component {
  setBodyHeight(h: number): void;
}

/**
 * Manual horizontal split [ rail │ chat + editor ]. The rail spans the FULL body height; the
 * right column stacks the bounded chat above the editor (measured, never clipped — its cursor
 * marker must survive). RESPONSIVE: the rail takes 40% of the terminal capped at `leftWidth`,
 * so it shrinks on smaller windows before it hides; below `splitMin` it hides entirely.
 */
export class Columns implements Component {
  private bodyH = 20;
  constructor(
    private readonly left: RailComponent,
    private readonly right: ChatPane,
    private readonly editor: Component,
    private readonly leftWidth: number,
    private readonly splitMin: number,
  ) {}
  setBodyHeight(h: number): void { this.bodyH = h; }
  splits(width: number): boolean { return width >= this.splitMin; }
  /** Actual rail width at this terminal width: min(cap, 40%). */
  railWidth(width: number): number { return Math.min(this.leftWidth, Math.floor(width * 0.4)); }
  invalidate(): void { this.left.invalidate(); this.right.invalidate(); this.editor.invalidate(); }
  render(width: number): string[] {
    if (!this.splits(width)) {
      const ed = this.editor.render(width); // measured, not assumed — the editor self-sizes / grows
      const chatH = Math.max(1, this.bodyH - ed.length);
      this.right.setHeight(chatH);
      return [...toLines(this.right.render(width), chatH), ...ed];
    }
    const lw = this.railWidth(width), rw = width - lw - 1;
    const ed = this.editor.render(rw);
    const chatH = Math.max(1, this.bodyH - ed.length);
    const h = chatH + ed.length;
    this.right.setHeight(chatH);
    this.left.setBodyHeight(h);
    const L = toLines(this.left.render(lw), h);
    const R = [...toLines(this.right.render(rw), chatH), ...ed];
    const out: string[] = [];
    for (let i = 0; i < h; i++) {
      // Editor lines render at rw so padExact only pads them — never truncates the cursor marker.
      const line = padExact(L[i], lw) + dim("│") + padExact(R[i], rw);
      out.push(visibleWidth(line) > width ? truncateToWidth(line, width) : line);
    }
    return out;
  }
}

/** Fixed-viewport root: header + body ([ rail │ chat+editor ]), always <= terminal rows. */
export class Screen implements Component {
  constructor(
    private readonly term: { rows: number; columns: number },
    private readonly header: Component,
    private readonly columns: Columns,
    private readonly minBody = 4,
  ) {}
  invalidate(): void { this.header.invalidate(); this.columns.invalidate(); }
  render(width: number): string[] {
    const rows = this.term.rows || 30;
    const head = this.header.render(width);
    this.columns.setBodyHeight(Math.max(this.minBody, rows - head.length));
    const out = [...head, ...this.columns.render(width)];
    // Never exceed the viewport. The body only overflows when the editor outgrows it (chat
    // floor = 1 line); clip the TOP so the editor and its cursor marker always survive.
    return out.length > rows ? out.slice(out.length - rows) : out;
  }
}
