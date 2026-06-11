// Owner Operator — the live thread rail (glance-only). Grouped by project; every ACTIVE thread
// is rendered identically with all its data points: row number · status glyph · priority ·
// title · recency · greyed next-step (no summary). The number is the operator's handle —
// `/done 1,3` in the chat resolves through the same core numbering (see core/sidebar.ts).
// No selection/cursor/navigation — it's a consistent display the chat sits beside.
// Renders RAW lines; the Columns layout in screen.ts pads each line and draws the separator.

import { visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";
import {
  numberThreads,
  stateCounts,
  displayTopic,
  type RepoGroup,
  type SidebarThread,
  type ThreadState,
} from "@owner-operator/core";

type Styler = (s: string) => string;
const sgr = (...c: number[]): Styler => (s) => `\x1b[${c.join(";")}m${s}\x1b[0m`;
const dim = sgr(2), bold = sgr(1), cyan = sgr(36), yellow = sgr(33), green = sgr(32), gray = sgr(90), red = sgr(1, 31);

const GLYPH: Record<ThreadState, string> = { "needs-you": "◐", working: "●", idle: "○", done: "✓" };
const COLOR: Record<ThreadState, Styler> = { "needs-you": yellow, working: green, idle: gray, done: gray };
const prio = (p: number): Styler => (p >= 5 ? red : p === 4 ? yellow : p === 3 ? cyan : gray);
// `working` animates (a spinner) so it reads as in-progress; the tui ticks the frame (see tui.ts).
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Compact recency for the row: "now" / "7m" / "3h" / "2d" (from the digest's lastActive). */
function shortAge(lastActive: string): string {
  if (/just now/i.test(lastActive)) return "now";
  const m = /^(\d+)\s*(\w)/.exec(lastActive);
  return m ? m[1] + m[2] : lastActive;
}

/**
 * Glance-only thread rail: grouped by project, every row showing the same data points. Fed the
 * rail rows (the triaged cards joined with live status). MIRRORS the cards — no filtering.
 * No interaction — pure render.
 */
export class SidebarList {
  private groups: RepoGroup[] = [];
  private counts: Record<ThreadState, number> = { "needs-you": 0, working: 0, idle: 0, done: 0 };
  private frame = 0; // spinner frame for `working` rows

  constructor(private bodyHeight = 18) {}

  /** Body rows the rail may use; the fixed-viewport layout sets this from terminal height. */
  setBodyHeight(h: number): void { this.bodyHeight = Math.max(3, h - 3); } // minus the 3-line header

  /** Takes ALL rail rows; done (inactive) rows leave the body but stay in the ✓ count. */
  setThreads(threads: readonly SidebarThread[]): void {
    this.counts = stateCounts(threads);
    this.groups = numberThreads(threads).groups;
  }

  /** True if any thread is `working` — the tui only animates the spinner when this holds. */
  hasWorking(): boolean { return this.groups.some((g) => g.threads.some((t) => t.state === "working")); }
  /** Advance the spinner one frame (driven by a tui timer). */
  tick(): void { this.frame = (this.frame + 1) % SPINNER.length; }

  invalidate(): void { /* stateless render */ }

  render(width: number): string[] {
    const W = Math.max(18, width);
    const all = this.groups.flatMap((g) => g.threads);
    const c = this.counts;
    const stats = [c["needs-you"] && yellow(`◐ ${c["needs-you"]}`), c.working && green(`● ${c.working}`), c.idle && gray(`○ ${c.idle}`), c.done && gray(`✓ ${c.done}`)]
      .filter(Boolean).join(dim("  ")) || dim("—");
    const head = [bold("Threads") + dim(`  ${all.length}`), stats, ""];
    if (!all.length) return [head[0], "", dim("(no active threads)")];

    // Every thread: line 1 = number · glyph · priority · title (right-aligned recency);
    // line 2 = grey next-step; line 3 = origin (git ±delta · the app it came from),
    // right-aligned. The number is what `/done` takes.
    const numW = String(all.length).length;
    const body: string[] = [];
    for (const g of this.groups) {
      body.push(cyan(bold(`▾ ${g.repo}`)) + dim(`  ${g.threads.length}`));
      for (const t of g.threads) {
        const badge = t.priority ? prio(t.priority)(`P${t.priority} `) : "";
        const age = dim(shortAge(t.lastActive));
        const glyph = t.state === "working" ? green(SPINNER[this.frame % SPINNER.length]) : COLOR[t.state](GLYPH[t.state]);
        const left = " " + dim(String(t.num ?? 0).padStart(numW)) + " " + glyph + " " + badge;
        const room = Math.max(4, W - visibleWidth(left) - visibleWidth(age) - 1);
        const title = truncateToWidth(displayTopic(t).replace(/\s+/g, " ").trim(), room);
        const l1 = left + title;
        const gap = Math.max(1, W - visibleWidth(l1) - visibleWidth(age));
        body.push(l1 + " ".repeat(gap) + age);
        if (t.nextSteps) body.push(dim("    → " + truncateToWidth(t.nextSteps.replace(/\s+/g, " ").trim(), W - 6)));
        const delta = t.diffAdded != null || t.diffDeleted != null
          ? green(`+${t.diffAdded ?? 0}`) + " " + red(`-${t.diffDeleted ?? 0}`) + "  " : "";
        const origin = delta + dim(truncateToWidth(t.app, Math.max(6, W - visibleWidth(delta) - 4)));
        body.push(" ".repeat(Math.max(1, W - visibleWidth(origin))) + origin);
      }
    }

    // Glance-only: no scroll cursor — show the top (loudest groups first) + an overflow marker.
    const h = Math.max(3, this.bodyHeight);
    const slice = body.slice(0, h);
    if (body.length > h) slice[h - 1] = dim(`  ↓ ${body.length - h + 1} more`);
    return [...head, ...slice];
  }
}
