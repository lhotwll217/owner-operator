// Owner Operator — chat transcript chrome: the render-layer pieces that give the chat log clear
// role separation (borrowed from pi / opencode / codex TUIs). Pure renderers — tui.ts owns the
// event wiring, these just turn state into ANSI lines so they preview without a TTY (chat.preview.ts):
//   · Block        — prefixes a child's lines with a styled left gutter (user bar, assistant bullet)
//   · StatusLine   — ONE animated line for the live turn state (working/thinking/running), updated
//                    in place and removed when output lands — the states never stack in the transcript
//   · StatusFooter — the pinned bottom bar: context gauge · tokens · model (from pi SessionStats)

import { visibleWidth, truncateToWidth, type Component } from "@earendil-works/pi-tui";

type Styler = (s: string) => string;
const sgr = (...c: number[]): Styler => (s) => `\x1b[${c.join(";")}m${s}\x1b[0m`;
const dim = sgr(2), bold = sgr(1), cyan = sgr(36), green = sgr(32), yellow = sgr(33), red = sgr(1, 31);

/**
 * Prefix every line of a child with a left gutter — the separation device every credible agent
 * TUI uses (a colored bar for user input, a marker for the assistant). `gutterW` is the gutter's
 * visible width; the child is rendered that much narrower so the row still fits `width`.
 */
export class Block implements Component {
  constructor(
    private readonly child: Component,
    private readonly firstGutter = "",
    private readonly contGutter = "",
    private readonly gutterW = 0,
  ) {}
  invalidate(): void { this.child.invalidate(); }
  render(width: number): string[] {
    const lines = this.child.render(Math.max(1, width - this.gutterW));
    if (!this.gutterW) return lines;
    return lines.map((l, i) => (i === 0 ? this.firstGutter : this.contGutter) + l);
  }
}

/**
 * Show a "> " prompt on the editor's input line. pi's Editor draws only top/bottom rules (no side
 * borders) and insets content by `paddingX` leading spaces — so we swap the first content line's
 * leading pad for the prompt. The cursor marker sits inside the content (after the pad), so it's
 * untouched, and the swap is width-neutral (prompt is the same visible width as the pad it replaces).
 * Wrap the real editor with this for rendering; keep the editor itself for focus/input.
 */
export class PromptEditor implements Component {
  constructor(private readonly editor: Component, private readonly prompt: string) {} // prompt: 2 visible cols
  invalidate(): void { this.editor.invalidate(); }
  render(width: number): string[] {
    const lines = this.editor.render(width);
    let placed = false;
    return lines.map((l) => {
      if (!placed && l.startsWith("  ")) { placed = true; return this.prompt + l.slice(2); }
      return l;
    });
  }
}

const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * The single live-status line for a turn: an animated spinner + the current phase (working /
 * thinking / running). tui.ts updates the phase IN PLACE and removes the line when the answer or
 * brief lands — so the transient states never stack up in the transcript. Reasoning traces aren't
 * shown (they aren't visible/useful) — thinking is just a phase label here.
 */
export class StatusLine implements Component {
  private frame = 0;
  constructor(private phase = "working") {}
  setPhase(phase: string): void { this.phase = phase; }
  tick(): void { this.frame = (this.frame + 1) % SPIN.length; }
  invalidate(): void { /* stateless */ }
  render(_width: number): string[] { return [cyan(SPIN[this.frame]) + dim(` ${this.phase}…`)]; }
}

/** Pinned status bar inputs — pulled from pi's SessionStats / getContextUsage (no token math here). */
export interface FooterData {
  model: string;
  contextTokens: number | null;
  contextWindow: number;
  percent: number | null;
  inTok: number;
  outTok: number;
  cacheTok: number;
}

/** Compact token count: 1234 → "1k", 4_000_000 → "4M". */
const fmtTok = (n: number): string =>
  n >= 1_000_000 ? (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M"
  : n >= 1_000 ? Math.round(n / 1_000) + "k"
  : String(n);

/**
 * The bottom status line: a context-window gauge, the turn's token spend, and the model — the
 * pinned "where am I" bar every agent TUI carries. Reads a snapshot via the callback so tui.ts
 * controls refresh cadence (on message/turn end, not every frame). Empty until there's data.
 */
export class StatusFooter implements Component {
  constructor(private readonly read: () => FooterData | null) {}
  invalidate(): void { /* stateless */ }
  render(width: number): string[] {
    const d = this.read();
    if (!d) return [];
    const cells = 12;
    const pct = d.percent ?? 0;
    const fill = Math.max(0, Math.min(cells, Math.round((pct / 100) * cells)));
    const bar = green("█".repeat(fill)) + dim("░".repeat(cells - fill));
    // % used, colored by how full the window is (gemini-cli: warn ≥50%, error ≥90%).
    const pctStyle = pct >= 90 ? red : pct >= 50 ? yellow : bold;
    const ctx = d.percent == null
      ? dim("ctx —")
      : dim("ctx ") + dim("[") + bar + dim("] ") + dim(`${fmtTok(d.contextTokens ?? 0)}/${fmtTok(d.contextWindow)} `) + pctStyle(`${Math.round(pct)}%`);
    const toks = dim("↑") + fmtTok(d.inTok) + dim(" ↓") + fmtTok(d.outTok) + (d.cacheTok ? dim(" ⚡") + fmtTok(d.cacheTok) : "");
    const sep = dim("  ·  ");
    const line = ctx + sep + toks + sep + cyan(d.model);
    const w = visibleWidth(line);
    // Pin the status to the RIGHT edge (pad on the left); truncate only if it can't fit.
    return [w >= width ? truncateToWidth(line, width) : " ".repeat(width - w) + line];
  }
}
