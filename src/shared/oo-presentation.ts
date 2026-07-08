// Owner Operator — the single presentation seam for the interactive terminal surface.
//
// One pure module owns every choice that makes bare `./oo` read as Owner Operator instead
// of stock pi: the identity marker, the minimal OO palette/theme, the per-turn status-line
// formatter, the compact tool renderers, and the silent-start options. `interactive.ts`
// stays a thin wiring shell that feeds these into pi's supported extension API — no fork.
//
// pi hooks used (see pi's docs/extensions.md + docs/tui.md):
//   ctx.ui.setStatus / setWorkingIndicator / setTheme   — status line, spinner, palette
//   tool `renderCall` / `renderResult`                  — one-line tool rows
//   pi.on("turn_start" | "tool_execution_*" | "agent_end") — drive the status line
//
// The startup banner is silenced through the supported `quietStartup` setting (.pi/settings.json),
// which is the only piece pi has no extension hook for — no shim needed.

import { Text, type Component } from "@earendil-works/pi-tui";
import {
  Theme,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionFactory,
  type InteractiveModeOptions,
  type ToolDefinition,
  type ThemeColor,
  type ToolRenderResultOptions,
  type WorkingIndicatorOptions,
} from "@earendil-works/pi-coding-agent";

// pi doesn't re-export ToolRenderContext from its entry point; derive it from ToolDefinition.
type AnyTool = ToolDefinition<any, any, any>;
type RenderContext = Parameters<NonNullable<AnyTool["renderCall"]>>[2];

// ---- Identity ------------------------------------------------------------------------
// A light marker, not a banner: one quiet line on start. Deliberately carries no pi
// branding — the whole point of the surface is that it reads as Owner Operator.
export const OO_NAME = "Owner Operator";

/** The one quiet identity line printed on start, e.g. "Owner Operator v0.0.0". */
export function ooMarker(version: string): string {
  return `${OO_NAME} v${version}`;
}

// ---- Palette & theme -----------------------------------------------------------------
// A deliberate, minimal OO palette: one accent + muted greys for the chrome. Functional
// signals (success/error/warning) and syntax highlighting stay legible — decluttering the
// branding, not the information. These values are OO's own; they don't track pi's theme.
export const ooPalette = {
  accent: "#b98a4b", // the single OO accent — a restrained bronze, distinct from pi's teal
  text: "#cfd2d6", // primary foreground
  muted: "#8b9099", // secondary / tool output
  dim: "#5b606b", // tertiary / borders / hints
  faint: "#3c4048", // faint chrome (thinking-off, muted borders)
} as const;

// The full color map pi's TUI needs — typed against ThemeColor so a missing token is a
// compile error. Chrome is neutralized to the OO greys + one accent; status and syntax
// colors are kept so results stay readable.
const OO_FG_COLORS: Record<ThemeColor, string> = {
  accent: ooPalette.accent,
  border: ooPalette.dim,
  borderAccent: ooPalette.accent,
  borderMuted: ooPalette.faint,
  success: "#b5bd68",
  error: "#cc6666",
  warning: "#e0af68",
  muted: ooPalette.muted,
  dim: ooPalette.dim,
  text: ooPalette.text,
  thinkingText: ooPalette.muted,
  userMessageText: ooPalette.text,
  customMessageText: ooPalette.text,
  customMessageLabel: ooPalette.muted,
  toolTitle: ooPalette.text,
  toolOutput: ooPalette.muted,
  mdHeading: ooPalette.accent,
  mdLink: "#81a2be",
  mdLinkUrl: ooPalette.dim,
  mdCode: ooPalette.accent,
  mdCodeBlock: ooPalette.text,
  mdCodeBlockBorder: ooPalette.faint,
  mdQuote: ooPalette.muted,
  mdQuoteBorder: ooPalette.faint,
  mdHr: ooPalette.faint,
  mdListBullet: ooPalette.accent,
  toolDiffAdded: "#b5bd68",
  toolDiffRemoved: "#cc6666",
  toolDiffContext: ooPalette.muted,
  syntaxComment: "#6A9955",
  syntaxKeyword: "#569CD6",
  syntaxFunction: "#DCDCAA",
  syntaxVariable: "#9CDCFE",
  syntaxString: "#CE9178",
  syntaxNumber: "#B5CEA8",
  syntaxType: "#4EC9B0",
  syntaxOperator: "#D4D4D4",
  syntaxPunctuation: "#D4D4D4",
  thinkingOff: ooPalette.faint,
  thinkingMinimal: "#6e6e6e",
  thinkingLow: "#5f87af",
  thinkingMedium: "#81a2be",
  thinkingHigh: "#b294bb",
  thinkingXhigh: "#d183e8",
  bashMode: ooPalette.accent,
};

const OO_BG_COLORS: Record<string, string> = {
  selectedBg: "#33353b",
  userMessageBg: "#2b2d33",
  customMessageBg: "#2b2d33",
  toolPendingBg: "#26282d",
  toolSuccessBg: "#26302a",
  toolErrorBg: "#352727",
};

/** Build the OO theme. `mode` should follow the terminal's color support. */
export function buildOoTheme(mode: "truecolor" | "256color" = "truecolor"): Theme {
  return new Theme(OO_FG_COLORS, OO_BG_COLORS as ConstructorParameters<typeof Theme>[1], mode, {
    name: "owner-operator",
  });
}

/** A tamed, low-key working indicator — a single pulsing dot in the OO accent. */
export function ooWorkingIndicator(theme: Theme): WorkingIndicatorOptions {
  return {
    frames: [
      theme.fg("dim", "·"),
      theme.fg("muted", "•"),
      theme.fg("accent", "●"),
      theme.fg("muted", "•"),
    ],
    intervalMs: 160,
  };
}

// ---- Per-turn status line ------------------------------------------------------------
// Decision §6: a single, in-place updating status line — never an accumulating wall of
// per-tool lines. This models the stream of tool/turn events as ONE current line: each
// event replaces it, none append. The extension mirrors `current` into `ctx.ui.setStatus`.

/** Human label for the activity a tool represents, e.g. "reading sessions…". */
export function statusLabelFor(toolName: string): string {
  switch (toolName) {
    case "get_current_session_state":
      return "reading session state…";
    case "mark_thread_done":
      return "updating threads…";
    case "query_database":
      return "querying the session database…";
    case "search_sessions":
      return "searching sessions…";
    case "schedule_prompt":
      return "scheduling…";
    case "read":
      return "reading…";
    case "grep":
      return "searching…";
    case "find":
      return "finding files…";
    case "ls":
      return "listing files…";
    default:
      return `${toolName.replace(/_/g, " ")}…`;
  }
}

const WORKING_LABEL = "thinking…";

export type OoTurnEvent =
  | { kind: "turn_start" }
  | { kind: "tool_start"; toolName: string }
  | { kind: "tool_end"; toolName: string }
  | { kind: "idle" };

/** The single current status line for a turn. Every event replaces it; none accumulate. */
export class OoStatusLine {
  private line: string | undefined;

  get current(): string | undefined {
    return this.line;
  }

  /** Apply one event and return the (single) current line. */
  apply(event: OoTurnEvent): string | undefined {
    switch (event.kind) {
      case "turn_start":
        this.line ??= WORKING_LABEL;
        break;
      case "tool_start":
        this.line = statusLabelFor(event.toolName);
        break;
      case "tool_end":
        // Keep the last activity visible until the next one starts — the loader row still
        // shows motion, so we don't blink the line back to a generic label between tools.
        break;
      case "idle":
        this.line = undefined;
        break;
    }
    return this.line;
  }
}

/** Fold a sequence of events to the single current line — the non-accumulation contract. */
export function foldStatusLine(events: readonly OoTurnEvent[]): string | undefined {
  const status = new OoStatusLine();
  for (const event of events) status.apply(event);
  return status.current;
}

// ---- Compact tool rendering ----------------------------------------------------------
// One muted line per tool call instead of a wall. `renderCall` names the activity; a
// summary of the arguments trails it. `renderResult` collapses to a single line by
// default (expandable with pi's normal tool-expand key).

const reuseText = (context: RenderContext): Text =>
  (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);

/** Pull the text blocks out of a tool result for the expanded view. */
function resultText(result: any): string {
  const content = result?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c: any) => c?.type === "text" && typeof c.text === "string")
      .map((c: any) => c.text)
      .join("\n");
  }
  return "";
}

/** A one-line `renderCall`: "‹label› ‹summary›" in muted/accent tones. */
export function ooRenderCall(label: string, summarize?: (args: any) => string) {
  return (args: any, theme: Theme, context: RenderContext): Component => {
    const text = reuseText(context);
    let line = theme.fg("dim", "› ") + theme.fg("toolTitle", label);
    const summary = summarize?.(args)?.trim();
    if (summary) line += " " + theme.fg("muted", summary);
    text.setText(line);
    return text;
  };
}

/** A one-line `renderResult`: a quiet ✓/✗ with an optional summary, expandable. */
export function ooRenderResult(summarize?: (result: any) => string) {
  return (
    result: any,
    options: ToolRenderResultOptions,
    theme: Theme,
    context: RenderContext,
  ): Component => {
    const text = reuseText(context);
    if (options.isPartial) {
      text.setText(theme.fg("muted", "working…"));
      return text;
    }
    const mark = context.isError ? theme.fg("error", "✗") : theme.fg("dim", "✓");
    const summary = summarize?.(result)?.trim();
    let line = summary ? `${mark} ${theme.fg("muted", summary)}` : mark;
    // Compact by default; on expand (pi's tool-expand key) show the raw result text.
    if (options.expanded) {
      const body = resultText(result).trim();
      if (body) line += "\n" + theme.fg("toolOutput", body);
    }
    text.setText(line);
    return text;
  };
}

/** Attach the compact OO renderers to a tool definition (leaving execution untouched). */
export function withOoRenderers(
  tool: AnyTool,
  label: string,
  opts: { summarizeCall?: (args: any) => string; summarizeResult?: (result: any) => string } = {},
): AnyTool {
  return {
    ...tool,
    renderCall: ooRenderCall(label, opts.summarizeCall),
    renderResult: ooRenderResult(opts.summarizeResult),
  };
}

// ---- Silent start --------------------------------------------------------------------
// Decision §5: no auto model turn. The interactive surface opens fully silent — no
// `initialMessage`. The owner asks; the ranked thread list lives in the widget (and
// `oo --session-state`), so there's no canned brief to re-narrate that deterministic state.
export function ooInteractiveOptions(): InteractiveModeOptions {
  return {};
}

// ---- The presentation extension ------------------------------------------------------
// Registered alongside `blacklistAwareFileToolsExtension` in the interactive runtime. It
// installs the theme + working indicator and drives the single status line from pi's turn/
// tool events. It changes only per-turn rendering and startup — no command wiring,
// keybindings, or model selection.
export const ooPresentationExtension: ExtensionFactory = (pi: ExtensionAPI) => {
  const status = new OoStatusLine();
  const push = (ctx: ExtensionContext) => ctx.ui.setStatus("oo", status.current);

  const applyLook = (ctx: ExtensionContext) => {
    const mode = ctx.ui.theme.getColorMode();
    ctx.ui.setTheme(buildOoTheme(mode));
    ctx.ui.setWorkingIndicator(ooWorkingIndicator(ctx.ui.theme));
  };

  pi.on("session_start", (_event, ctx) => applyLook(ctx));

  pi.on("turn_start", (_event, ctx) => {
    status.apply({ kind: "turn_start" });
    push(ctx);
  });
  pi.on("tool_execution_start", (event, ctx) => {
    status.apply({ kind: "tool_start", toolName: event.toolName });
    push(ctx);
  });
  pi.on("tool_execution_end", (event, ctx) => {
    status.apply({ kind: "tool_end", toolName: event.toolName });
    push(ctx);
  });
  pi.on("agent_end", (_event, ctx) => {
    status.apply({ kind: "idle" });
    push(ctx);
  });
};
