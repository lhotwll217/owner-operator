// Owner Operator — fixed-viewport layout. pi-tui is inline/scrollback: it only redraws in
// place (no native-scrollback growth) when the whole frame is <= terminal rows. So the rail
// can only stay pinned if we render a bounded frame every tick. `Screen` enforces that
// (header + body + editor, always <= rows); `Columns` is the manual [ rail │ chat ] split
// (pi-tui has no columns primitive); `ChatPane` bounds the growing chat to its tail.

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

/** Manual horizontal split [ left │ right ]. Below `splitMin` the rail hides, chat goes full-width. */
export class Columns implements Component {
  private bodyH = 20;
  constructor(
    private readonly left: RailComponent,
    private readonly right: ChatPane,
    private readonly leftWidth: number,
    private readonly splitMin: number,
  ) {}
  setBodyHeight(h: number): void { this.bodyH = h; this.left.setBodyHeight(h); this.right.setHeight(h); }
  splits(width: number): boolean { return width >= this.splitMin; }
  invalidate(): void { this.left.invalidate(); this.right.invalidate(); }
  render(width: number): string[] {
    if (!this.splits(width)) return toLines(this.right.render(width), this.bodyH);
    const lw = this.leftWidth, rw = width - lw - 1;
    const L = toLines(this.left.render(lw), this.bodyH);
    const R = toLines(this.right.render(rw), this.bodyH);
    const out: string[] = [];
    for (let i = 0; i < this.bodyH; i++) {
      const line = padExact(L[i], lw) + dim("│") + padExact(R[i], rw);
      out.push(visibleWidth(line) > width ? truncateToWidth(line, width) : line);
    }
    return out;
  }
}

/** Fixed-viewport root: header + body + editor, always <= terminal rows so it never scrolls. */
export class Screen implements Component {
  constructor(
    private readonly term: { rows: number; columns: number },
    private readonly header: Component,
    private readonly columns: Columns,
    private readonly editor: Component,
    private readonly minBody = 3,
  ) {}
  invalidate(): void { this.header.invalidate(); this.columns.invalidate(); this.editor.invalidate(); }
  render(width: number): string[] {
    const rows = this.term.rows || 30;
    const head = this.header.render(width);
    const ed = this.editor.render(width); // measured, not assumed — the editor self-sizes / grows
    let bodyH = Math.max(this.minBody, rows - head.length - ed.length);
    this.columns.setBodyHeight(bodyH);
    let body = this.columns.render(width);
    let out = [...head, ...body, ...ed];
    // Never exceed the viewport — trim the BODY only (never the editor or its cursor marker).
    if (out.length > rows) {
      bodyH = Math.max(0, bodyH - (out.length - rows));
      this.columns.setBodyHeight(bodyH);
      out = [...head, ...this.columns.render(width), ...ed];
    }
    return out;
  }
}
