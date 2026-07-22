// Owner Operator — the single presentation seam for the interactive terminal surface.
//
// This adapter owns the choices that make bare `./oo` read as Owner Operator instead of
// stock pi: the identity marker, palette/theme, tool-detail gate, and silent-start options.
// Browser-safe activity policy lives in @owner-operator/core/activity; turn-trace.ts adapts it
// to Pi and the terminal. `interactive.ts`
// stays a thin wiring shell that feeds these into pi's supported extension API — no fork.
//
// pi hooks used (see pi's docs/extensions.md + docs/tui.md, shipped in the package):
//   custom session entries + entry renderer — deterministic live/replay turn timelines.
//   ctx.ui.setTheme — Owner Operator styling.
//   tool `renderCall` / `renderResult` — one-line tool rows (for tools that opt in).
//
// The startup banner is silenced through the supported `quietStartup` setting (.pi/settings.json).
// Two things pi has no extension hook for — tool-execution rows and thinking blocks landing in
// the chat scrollback — are handled by the `quietOoInteractiveMode` shim at the bottom.

import { Text, type Component } from "@earendil-works/pi-tui";
import type { AgentRunHarness, AgentRunStatus } from "@owner-operator/core";
import { formatTurnDuration } from "@owner-operator/core/activity";
import { formatAgentRunIdentity } from "@owner-operator/core/agent-state";
import { OO_TURN_ACTIVITY_ENTRY, turnTraceExtension } from "./turn-trace";
import {
  Theme,
  type ExtensionAPI,
  type ExtensionFactory,
  type InteractiveModeOptions,
  type ToolDefinition,
  type ThemeColor,
  type ToolRenderResultOptions,
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
  thinkingMax: "#ef9aeb",
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

// ---- Delegated-run row -------------------------------------------------------------------
// Issue #69: a delegated run must not read as a generic tool call. The delegate/manage tools
// render a compact agent row — harness/model · task · state · elapsed — so the terminal shows what
// the child is and where it stands without activity, result, failure, or retry dumps.

/** The wire AgentRun fields read by the compact terminal presentation. */
export interface AgentRunRowView {
  harness?: AgentRunHarness;
  model?: string | null;
  task?: string;
  status?: AgentRunStatus;
  createdAt?: string | null;
  finishedAt?: string | null;
}

/** Human elapsed between two ISO stamps, e.g. "2m 3s". Empty when either is missing. */
export function elapsedLabel(fromIso?: string | null, toIso?: string | null): string {
  if (!fromIso || !toIso) return "";
  const durationMs = Date.parse(toIso) - Date.parse(fromIso);
  return Number.isFinite(durationMs) ? formatTurnDuration(durationMs) : "";
}

/** One compact line for a delegated run. Activity/result/error bodies never enter this view. */
export function formatAgentRunRow(run: AgentRunRowView, nowIso?: string): string {
  const parts: string[] = [];
  if (run.harness) parts.push(formatAgentRunIdentity(run.harness, run.model ?? null));
  if (run.task) parts.push(truncate(run.task, 60));
  if (run.status) parts.push(run.status);
  const elapsed = elapsedLabel(run.createdAt, run.finishedAt ?? nowIso ?? null);
  if (elapsed) parts.push(elapsed);
  return parts.join(" · ");
}

function truncate(value: string, max: number): string {
  const trimmed = value.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
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
// installs the theme and delegates all turn behavior to the Pi TurnTrace adapter.
export const ooPresentationExtension: ExtensionFactory = (pi: ExtensionAPI) => {
  turnTraceExtension(pi);
  pi.on("session_start", (_event, ctx) => {
    const mode = ctx.ui.theme.getColorMode();
    ctx.ui.setTheme(buildOoTheme(mode));
  });
};

// ---- Zero-dump shim ------------------------------------------------------------------
// Three things pi renders into the chat scrollback with no extension hook to stop them:
// tool-execution rows (`chatContainer.addChild(new ToolExecutionComponent(...))`), thinking
// blocks inside assistant messages (`hideThinkingBlock` still renders a label line — and an
// empty label is ANSI-wrapped, so pi-tui emits a blank padded line, ~2 blank lines per
// reasoning turn), and package/version update notifications on launch. We own the
// InteractiveMode construction site (interactive.ts), so we quiet all three at its one chat
// seam: every chat component passes through `chatContainer.addChild`. #34's PRD sanctioned
// exactly this kind of thin shim for the pieces pi exposes no API for. Components are matched
// by class name, so a pi rename fails loudly in the unit test (which renders pi's real
// components) rather than silently letting the dump back in.
const TOOL_EXECUTION_COMPONENT = "ToolExecutionComponent";
const ASSISTANT_MESSAGE_COMPONENT = "AssistantMessageComponent";
const CUSTOM_ENTRY_COMPONENT = "CustomEntryComponent";
const VISIBLE_TOOL_ROWS = new Set(["delegate_agent", "manage_agent_run"]);

const className = (child: unknown): string | undefined =>
  (child as { constructor?: { name?: string } } | null)?.constructor?.name;

/** True for Pi's tool-row component. */
export function isToolExecutionRow(child: unknown): boolean {
  return className(child) === TOOL_EXECUTION_COMPONENT;
}

/** Delegated-run tools own compact snapshot rendering, so their rows remain visible without raw
 * expansion. Pi's pinned ToolExecutionComponent constructor stores `toolName` on the component;
 * see node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js. */
function isVisibleToolExecutionRow(child: unknown): boolean {
  const toolName = (child as { toolName?: unknown } | null)?.toolName;
  return typeof toolName === "string" && VISIBLE_TOOL_ROWS.has(toolName);
}

/** Keep raw tool components in their source position, but render zero lines until Pi's separate
 * tool-detail expansion is explicitly enabled. The pinned Pi expansion contract and the reason
 * this narrow construction-site shim exists are recorded in docs/inspiration.md. */
function gateRawToolDetail(child: unknown): void {
  const component = child as {
    expanded?: boolean;
    render?: (width: number) => string[];
    setExpanded?: (expanded: boolean) => void;
  };
  let rawExpanded = component.expanded === true;
  if (typeof component.render === "function") {
    const render = component.render.bind(component);
    component.render = (width: number): string[] => rawExpanded ? render(width) : [];
  }
  if (typeof component.setExpanded !== "function") return;
  const setExpanded = component.setExpanded.bind(component);
  component.setExpanded = (expanded: boolean): void => {
    rawExpanded = expanded;
    setExpanded(expanded);
  };
}

/** True for the pi assistant-message component whose thinking rendering we mute. */
export function isAssistantMessageRow(child: unknown): boolean {
  return className(child) === ASSISTANT_MESSAGE_COMPONENT;
}

function isTurnTraceEntry(child: unknown): boolean {
  if (className(child) !== CUSTOM_ENTRY_COMPONENT) return false;
  return (child as { entry?: { customType?: unknown } }).entry?.customType === OO_TURN_ACTIVITY_ENTRY;
}

/** An assistant message stripped to owner-facing output. Thinking and provider diagnostics stay
 * out of the transcript; partial response text remains. TurnTrace supplies a concise interruption
 * marker after settlement, independently of Pi's raw error prose. */
function ownerFacingAssistantMessage<T>(message: T): T {
  const content = (message as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return message;
  const visibleContent = content.filter((c) => c?.type !== "thinking");
  const value = message as { stopReason?: unknown };
  const technicalStop = value.stopReason === "aborted"
    || value.stopReason === "error"
    || value.stopReason === "length";
  if (!technicalStop && visibleContent.length === content.length) return message;
  return {
    ...(message as object),
    content: visibleContent,
    ...(technicalStop ? { stopReason: "stop", errorMessage: undefined } : {}),
  } as T;
}

/** Re-route a component's `updateContent` through the owner-facing filter, in place. Covers both pi
 * paths: streaming (component added empty, then updateContent streams into it) and finalized
 * (the constructor renders the message before addChild — so re-render what's already there). */
function muteThinkingRendering(child: unknown): void {
  const component = child as { updateContent?: (message: unknown) => void; lastMessage?: unknown };
  if (typeof component.updateContent !== "function") return;
  const original = component.updateContent.bind(component);
  component.updateContent = (message: unknown): void => original(ownerFacingAssistantMessage(message));
  if (component.lastMessage) component.updateContent(component.lastMessage);
}

/** Quiet a constructed pi InteractiveMode in place: Pi expansion reveals semantic turn traces
 * first and raw tool rows second; thinking blocks never render and startup notices stay silent.
 * Structural (duck-typed) so it never imports Pi internals; a no-op if Pi's shape shifts. */
export function quietOoInteractiveMode(mode: unknown): void {
  if (typeof mode !== "object" || mode === null) return;
  const m = mode as {
    chatContainer?: { children?: unknown[]; addChild?: (child: unknown) => void };
    toolOutputExpanded?: boolean;
    toggleToolOutputExpansion?: unknown;
    ui?: { requestRender?: () => void };
    showPackageUpdateNotification?: unknown;
    showNewVersionNotification?: unknown;
  };
  const chat = m.chatContainer;
  let expansionStage: 0 | 1 | 2 = 0;
  const setComponentExpansion = (child: unknown): void => {
    const expandable = child as { setExpanded?: (expanded: boolean) => void };
    if (typeof expandable.setExpanded !== "function") return;
    expandable.setExpanded(isTurnTraceEntry(child) ? expansionStage >= 1 : expansionStage >= 2);
  };
  if (chat && typeof chat.addChild === "function") {
    const original = chat.addChild.bind(chat);
    chat.addChild = (child: unknown): void => {
      if (isToolExecutionRow(child) && !isVisibleToolExecutionRow(child)) gateRawToolDetail(child);
      if (isAssistantMessageRow(child)) muteThinkingRendering(child); // reasoning renders nothing
      setComponentExpansion(child);
      original(child);
    };
  }
  if ("toggleToolOutputExpansion" in m) {
    m.toggleToolOutputExpansion = (): void => {
      expansionStage = ((expansionStage + 1) % 3) as 0 | 1 | 2;
      m.toolOutputExpanded = expansionStage === 2;
      for (const child of chat?.children ?? []) setComponentExpansion(child);
      m.ui?.requestRender?.();
    };
  }
  // Startup update notices are pi self-promotion irrelevant to the owner; OO owns its own deps.
  if ("showPackageUpdateNotification" in m) m.showPackageUpdateNotification = (): void => {};
  if ("showNewVersionNotification" in m) m.showNewVersionNotification = (): void => {};
}
