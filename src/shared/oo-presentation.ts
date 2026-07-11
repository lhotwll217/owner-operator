// Owner Operator — the single presentation seam for the interactive terminal surface.
//
// One pure module owns every choice that makes bare `./oo` read as Owner Operator instead
// of stock pi: the identity marker, the minimal OO palette/theme, the per-turn status-line
// formatter, the compact tool renderers, and the silent-start options. `interactive.ts`
// stays a thin wiring shell that feeds these into pi's supported extension API — no fork.
//
// pi hooks used (see pi's docs/extensions.md + docs/tui.md, shipped in the package):
//   ctx.ui.setWorkingMessage / setWorkingVisible / setWorkingIndicator / setTheme
//     — pi's one streaming loader row is THE status line; nothing else moves.
//   pi.on("turn_start" | "message_update" | "tool_execution_*" | "agent_end")
//     — drive that line from the stream deltas (thinking/toolcall = working, text = answer).
//   tool `renderCall` / `renderResult` — one-line tool rows (for tools that opt in).
//
// The startup banner is silenced through the supported `quietStartup` setting (.pi/settings.json).
// Two things pi has no extension hook for — tool-execution rows and thinking blocks landing in
// the chat scrollback — are handled by the `quietOoInteractiveMode` shim at the bottom.

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

// ---- The single working line ---------------------------------------------------------
// Decision §6 (issue #34): one in-place line during a turn — never an accumulating wall.
// It drives pi's streaming loader message (ctx.ui.setWorkingMessage), the single point where
// activity surfaces. Between tools it cycles character words; while a tool runs it names the
// tool; when the answer streams (or the turn ends) it clears. Reasoning renders nothing in the
// chat (quietOoInteractiveMode strips it), so this line — not a dumped block — is the live
// "the Operator is thinking" signal.

/** The cycling character words shown between tool calls — the Owner Operator persona,
 * confident chief-of-staff, not cutesy. */
export const OO_CYCLE_WORDS = [
  "working…",
  "on it…",
  "owning it…",
  "operating…",
  "taking stock…",
  "connecting the dots…",
  "minding the store…",
  "making it happen…",
  "getting it done…",
  "doing the thing…",
  "owning and operating…",
] as const;

/** How often the cycling word advances, in ms. */
export const OO_CYCLE_MS = 2000;

/** Ticks a finished tool's label lingers before cycling resumes — even an instant tool
 * (get_current_session_state returns in ms) stays legible for ~2 beats instead of flashing by. */
export const OO_TOOL_LINGER_TICKS = 2;

/** Human label for the activity a tool represents, e.g. "searching sessions…". */
export function statusLabelFor(toolName: string): string {
  switch (toolName) {
    case "get_current_session_state":
      return "reading session state…";
    case "mark_thread_done":
      return "updating threads…";
    case "query_database":
      return "querying the session database…";
    case "schedule_prompt":
      return "scheduling…";
    case "bash":
      return "running a command…";
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

export type OoWorkEvent =
  | { kind: "tick" }
  | { kind: "tool_start"; toolName: string }
  | { kind: "tool_end" }
  | { kind: "resume" }
  | { kind: "idle" };

/** The single working line for a turn. `resume` starts (or revives) the cycling words; `tick`
 * advances them; a running tool overrides them with its label, which lingers a couple of beats
 * past `tool_end`; `idle` clears the line. Every event replaces the line — nothing accumulates,
 * so a turn is one moving line, never a wall. */
export class OoWorkingLine {
  private phase: "idle" | "cycle" | "tool" | "tool_done" = "idle";
  private cycleIdx = 0;
  private lingerLeft = 0;
  private toolLabel: string | undefined;

  get current(): string | undefined {
    if (this.phase === "idle") return undefined;
    if (this.phase === "tool" || this.phase === "tool_done") return this.toolLabel;
    return OO_CYCLE_WORDS[this.cycleIdx % OO_CYCLE_WORDS.length];
  }

  /** Apply one event and return the (single) current line. */
  apply(event: OoWorkEvent): string | undefined {
    switch (event.kind) {
      case "tick":
        // A running tool owns the line. A just-finished tool lingers OO_TOOL_LINGER_TICKS more
        // beats — so even a millisecond-fast tool is legible — then cycling resumes.
        if (this.phase === "tool_done") {
          this.lingerLeft -= 1;
          if (this.lingerLeft <= 0) {
            this.phase = "cycle";
            this.cycleIdx = (this.cycleIdx + 1) % OO_CYCLE_WORDS.length;
          }
        } else if (this.phase === "cycle") {
          this.cycleIdx = (this.cycleIdx + 1) % OO_CYCLE_WORDS.length;
        }
        break;
      case "tool_start":
        this.phase = "tool";
        this.toolLabel = statusLabelFor(event.toolName);
        break;
      case "tool_end":
        // Hold the label a couple of beats; don't snap back to a cycle word instantly.
        if (this.phase === "tool") {
          this.phase = "tool_done";
          this.lingerLeft = OO_TOOL_LINGER_TICKS;
        }
        break;
      case "resume":
        // Revive cycling only from idle — a running/lingering tool label keeps the line, and the
        // cycle picks up where it left off rather than restarting on the same word every turn.
        if (this.phase === "idle") this.phase = "cycle";
        break;
      case "idle":
        this.phase = "idle";
        this.toolLabel = undefined;
        break;
    }
    return this.current;
  }
}

/** Fold a sequence of events to the single current line — the non-accumulation contract. */
export function foldWorkingLine(events: readonly OoWorkEvent[]): string | undefined {
  const line = new OoWorkingLine();
  for (const event of events) line.apply(event);
  return line.current;
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
// installs the theme + working indicator and drives the single working line from pi's turn,
// stream-delta, and tool events. It changes only per-turn rendering and startup — no command
// wiring, keybindings, or model selection.
export const ooPresentationExtension: ExtensionFactory = (pi: ExtensionAPI) => {
  const work = new OoWorkingLine();
  let ui: ExtensionContext["ui"] | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  const push = (): void => ui?.setWorkingMessage(work.current);
  const stopTimer = (): void => {
    if (timer) clearInterval(timer);
    timer = undefined;
  };
  // The cycling word advances on a steady beat (turn/tool events alone don't tick). Never
  // restarted while running — codex emits many thinking segments per turn, and resetting the
  // interval on each would stall the word. unref'd so it can't keep the process alive;
  // agent_end + session_shutdown stop it either way.
  const ensureTimer = (): void => {
    if (timer) return;
    timer = setInterval(() => {
      work.apply({ kind: "tick" });
      push();
    }, OO_CYCLE_MS);
    timer.unref?.();
  };

  // Reveal the line (an answer-stream may have hidden it), apply the event, keep the beat going.
  const showWorking = (ctx: ExtensionContext, event: OoWorkEvent): void => {
    ui = ctx.ui;
    ctx.ui.setWorkingVisible(true);
    work.apply(event);
    push();
    ensureTimer();
  };
  const hideWorking = (ctx: ExtensionContext): void => {
    ui = ctx.ui;
    stopTimer();
    work.apply({ kind: "idle" });
    ctx.ui.setWorkingVisible(false);
  };

  pi.on("session_start", (_event, ctx) => {
    ui = ctx.ui;
    const mode = ctx.ui.theme.getColorMode();
    ctx.ui.setTheme(buildOoTheme(mode));
    ctx.ui.setWorkingIndicator(ooWorkingIndicator(ctx.ui.theme));
  });

  pi.on("turn_start", (_event, ctx) => showWorking(ctx, { kind: "resume" }));

  // The stream deltas say which phase the turn is in (a `*_start` always precedes its deltas):
  //   thinking → the Operator reasons; the cycle words carry the line (reasoning renders nothing).
  //   toolcall → a tool call is being written; name it as early as the stream knows the name.
  //   text     → the answer is streaming into the chat; the line has done its job — drop it, don't
  //              let it linger under the reply. If the text turns out to be a preamble before more
  //              tool calls, the next toolcall/thinking event brings the line straight back.
  pi.on("message_update", (event, ctx) => {
    const delta = event.assistantMessageEvent;
    switch (delta.type) {
      case "thinking_start":
        showWorking(ctx, { kind: "resume" });
        break;
      case "toolcall_start": {
        const call = delta.partial.content[delta.contentIndex];
        showWorking(
          ctx,
          call?.type === "toolCall" && call.name
            ? { kind: "tool_start", toolName: call.name }
            : { kind: "resume" },
        );
        break;
      }
      case "text_start":
        hideWorking(ctx);
        break;
    }
  });

  pi.on("tool_execution_start", (event, ctx) => showWorking(ctx, { kind: "tool_start", toolName: event.toolName }));
  pi.on("tool_execution_end", (_event, ctx) => {
    ui = ctx.ui;
    work.apply({ kind: "tool_end" }); // label lingers OO_TOOL_LINGER_TICKS beats, then cycling resumes
    push();
  });
  pi.on("agent_end", (_event, ctx) => hideWorking(ctx));
  pi.on("session_shutdown", () => stopTimer());
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

const className = (child: unknown): string | undefined =>
  (child as { constructor?: { name?: string } } | null)?.constructor?.name;

/** True for the pi tool-row component we drop from the chat scrollback. */
export function isToolExecutionRow(child: unknown): boolean {
  return className(child) === TOOL_EXECUTION_COMPONENT;
}

/** True for the pi assistant-message component whose thinking rendering we mute. */
export function isAssistantMessageRow(child: unknown): boolean {
  return className(child) === ASSISTANT_MESSAGE_COMPONENT;
}

/** An assistant message minus its thinking items — text, tool calls, stop reason untouched.
 * The model still reasons (nothing here touches the request); only the rendering goes. */
function stripThinking<T>(message: T): T {
  const content = (message as { content?: unknown } | null)?.content;
  if (!Array.isArray(content) || !content.some((c) => c?.type === "thinking")) return message;
  return { ...(message as object), content: content.filter((c) => c?.type !== "thinking") } as T;
}

/** Re-route a component's `updateContent` through stripThinking, in place. Covers both pi
 * paths: streaming (component added empty, then updateContent streams into it) and finalized
 * (the constructor renders the message before addChild — so re-render what's already there). */
function muteThinkingRendering(child: unknown): void {
  const component = child as { updateContent?: (message: unknown) => void; lastMessage?: unknown };
  if (typeof component.updateContent !== "function") return;
  const original = component.updateContent.bind(component);
  component.updateContent = (message: unknown): void => original(stripThinking(message));
  if (component.lastMessage) component.updateContent(component.lastMessage);
}

/** Quiet a constructed pi InteractiveMode in place: no tool-row dumps, no thinking blocks (or
 * their blank label lines), no startup update notices. Structural (duck-typed) so it never
 * imports pi internals; a no-op if pi's shape shifts. The dropped tool components still live in
 * pi's `pendingTools` map, so execution, results, and expand/collapse all keep working — they
 * just never reach the scrollback. */
export function quietOoInteractiveMode(mode: unknown): void {
  if (typeof mode !== "object" || mode === null) return;
  const m = mode as {
    chatContainer?: { addChild?: (child: unknown) => void };
    showPackageUpdateNotification?: unknown;
    showNewVersionNotification?: unknown;
  };
  const chat = m.chatContainer;
  if (chat && typeof chat.addChild === "function") {
    const original = chat.addChild.bind(chat);
    chat.addChild = (child: unknown): void => {
      if (isToolExecutionRow(child)) return; // never reaches scrollback; the working line shows it
      if (isAssistantMessageRow(child)) muteThinkingRendering(child); // reasoning renders nothing
      original(child);
    };
  }
  // Startup update notices are pi self-promotion irrelevant to the owner; OO owns its own deps.
  if ("showPackageUpdateNotification" in m) m.showPackageUpdateNotification = (): void => {};
  if ("showNewVersionNotification" in m) m.showNewVersionNotification = (): void => {};
}
