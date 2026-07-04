// Owner Operator — fixed-viewport layout. pi-tui is inline/scrollback: it only redraws in
// place (no native-scrollback growth) when the whole frame is <= terminal rows. So the sidebar
// can only stay pinned if we render a bounded frame every tick. `Screen` enforces that
// (header + body, always <= rows); `Columns` is the manual [ sidebar │ chat-over-editor ] split
// (pi-tui has no columns primitive) — a TRUE sidebar: the sidebar spans the full body height and
// the editor lives INSIDE the right column, so the input never runs under the sidebar;
// `ChatPane` bounds the growing chat to its tail.

import { visibleWidth, truncateToWidth, type Component } from "@earendil-works/pi-tui";

const dim = (s: string): string => `\x1b[2m${s}\x1b[0m`;
// A clearly-visible gray for the structural borders (the sidebar separator) — stronger than dim,
// which nearly disappears against the background.
const border = (s: string): string => `\x1b[90m${s}\x1b[0m`;

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

/**
 * Bounded, scrollable viewport over the (growing) chat content. Follows the tail by default
 * (newest at the bottom); the owner can scroll back into history (PgUp/PgDn in tui.ts).
 * `scrollback` = lines hidden BELOW the viewport (0 = pinned to the latest). While scrolled up,
 * the reading position is anchored to its TOP line, so streaming output appended below doesn't
 * drag the text out from under you — it only grows the "↓ more" tail.
 */
export class ChatPane implements Component {
  private height = 20;
  private scrollback = 0;      // lines below the viewport; 0 = following the latest
  private following = true;    // pinned to the tail until the owner scrolls up
  private lastTotal = 0;       // content height last render — to hold position as lines stream in
  constructor(private readonly child: Component) {}
  setHeight(h: number): void { this.height = Math.max(1, h); }
  /** A page is one viewport, minus a line of overlap so context carries across the jump. */
  pageStep(): number { return Math.max(1, this.height - 1); }

  /** Scroll by `delta` lines: negative = toward older (up), positive = toward newer (down). */
  scroll(delta: number): void {
    if (delta < 0) { this.following = false; this.scrollback += -delta; }
    else if (delta > 0) {
      this.scrollback = Math.max(0, this.scrollback - delta);
      if (this.scrollback === 0) this.following = true;
    }
  }
  /** Jump back to the latest line (resume following the tail). */
  toBottom(): void { this.following = true; this.scrollback = 0; }

  invalidate(): void { this.child.invalidate(); }
  render(width: number): string[] {
    const lines = this.child.render(width);
    const h = this.height;
    if (lines.length <= h) { this.following = true; this.scrollback = 0; this.lastTotal = lines.length; return lines; }
    // Hold the reading position as new lines stream in below: grow scrollback by the new lines
    // so the top of the view stays put (no drift while you read history during a live turn).
    if (!this.following && lines.length > this.lastTotal) this.scrollback += lines.length - this.lastTotal;
    this.lastTotal = lines.length;
    const maxOff = lines.length - h;
    this.scrollback = Math.min(Math.max(0, this.scrollback), maxOff);
    if (this.scrollback === 0) this.following = true;
    const start = maxOff - this.scrollback;
    const view = lines.slice(start, start + h);
    if (start > 0) view[0] = dim(`  ↑ ${start} earlier`);
    if (this.scrollback > 0) view[view.length - 1] = dim(`  ↓ ${this.scrollback} more`);
    return view;
  }
}

/** The left column must accept a body height. */
export interface SidebarComponent extends Component {
  setBodyHeight(h: number): void;
}

/**
 * Manual horizontal split [ sidebar │ chat + editor ]. The sidebar spans the FULL body height; the
 * right column stacks the bounded chat above the editor (measured, never clipped — its cursor
 * marker must survive). RESPONSIVE: the sidebar takes 40% of the terminal capped at `leftWidth`,
 * so it shrinks on smaller windows before it hides; below `splitMin` it hides entirely.
 */
export class Columns implements Component {
  private bodyH = 20;
  private sidebarHidden = false; // owner toggle: collapse the sidebar so chat fills the width (clean copy)
  constructor(
    private readonly left: SidebarComponent,
    private readonly right: ChatPane,
    private readonly editor: Component,
    private readonly leftWidth: number,
    private readonly splitMin: number,
  ) {}
  setBodyHeight(h: number): void { this.bodyH = h; }
  /** Hide/show the sidebar; when hidden the chat goes full width with no separator to bleed into a
   *  copy. Returns the new hidden state. */
  toggleSidebar(): boolean { this.sidebarHidden = !this.sidebarHidden; return this.sidebarHidden; }
  splits(width: number): boolean { return !this.sidebarHidden && width >= this.splitMin; }
  /** Actual sidebar width at this terminal width: min(cap, 40%). */
  sidebarWidth(width: number): number { return Math.min(this.leftWidth, Math.floor(width * 0.4)); }
  invalidate(): void { this.left.invalidate(); this.right.invalidate(); this.editor.invalidate(); }
  render(width: number): string[] {
    if (!this.splits(width)) {
      const ed = this.editor.render(width); // measured, not assumed — the editor self-sizes / grows
      const chatH = Math.max(1, this.bodyH - ed.length);
      this.right.setHeight(chatH);
      return [...toLines(this.right.render(width), chatH), ...ed];
    }
    const lw = this.sidebarWidth(width), rw = width - lw - 1;
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
      const line = padExact(L[i], lw) + border("│") + padExact(R[i], rw);
      out.push(visibleWidth(line) > width ? truncateToWidth(line, width) : line);
    }
    return out;
  }
}

/** Fixed-viewport root: header + body ([ sidebar │ chat+editor ]) + optional pinned footer (the
 *  status bar), always <= terminal rows. */
export class Screen implements Component {
  constructor(
    private readonly term: { rows: number; columns: number },
    private readonly header: Component,
    private readonly columns: Columns,
    private readonly footer?: Component,
    private readonly minBody = 4,
  ) {}
  invalidate(): void { this.header.invalidate(); this.columns.invalidate(); this.footer?.invalidate(); }
  render(width: number): string[] {
    const rows = this.term.rows || 30;
    const head = this.header.render(width);
    const foot = this.footer ? this.footer.render(width) : [];
    this.columns.setBodyHeight(Math.max(this.minBody, rows - head.length - foot.length));
    const out = [...head, ...this.columns.render(width), ...foot];
    // Never exceed the viewport. The body only overflows when the editor outgrows it (chat
    // floor = 1 line); clip the TOP so the editor, its cursor marker, and the footer survive.
    return out.length > rows ? out.slice(out.length - rows) : out;
  }
}
