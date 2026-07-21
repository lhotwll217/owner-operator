import {
  applyTurnTraceEvent,
  createTurnTrace,
  deriveTurnTraceView,
  semanticActionForTool,
  type TurnActivityEvent,
  type TurnTrace,
  type TurnTraceView,
} from "@owner-operator/core/activity";
import { Text, type Component } from "@earendil-works/pi-tui";
import type {
  ExtensionFactory,
  Theme,
} from "@earendil-works/pi-coding-agent";

export const OO_TURN_ACTIVITY_ENTRY = "owner-operator.turn-activity.v1";

const finiteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** Validate and copy persisted data so extra fields can never reach the activity reducer/view. */
function parseTurnActivityEvent(value: unknown): TurnActivityEvent | undefined {
  if (!value || typeof value !== "object") return undefined;
  const event = value as Record<string, unknown>;
  if (typeof event.kind !== "string" || typeof event.turnId !== "string" || !finiteNumber(event.at)) return undefined;
  switch (event.kind) {
    case "turn_started":
      return { kind: "turn_started", turnId: event.turnId, at: event.at };
    case "thinking_summary":
      if (typeof event.eventId !== "string" || typeof event.summary !== "string") return undefined;
      return { kind: "thinking_summary", turnId: event.turnId, eventId: event.eventId, at: event.at, summary: event.summary };
    case "tool":
      if (typeof event.eventId !== "string" || typeof event.toolName !== "string") return undefined;
      return { kind: "tool", turnId: event.turnId, eventId: event.eventId, at: event.at, toolName: event.toolName };
    case "turn_settled":
      if (event.outcome !== "completed" && event.outcome !== "interrupted") return undefined;
      if (event.hasResponse !== undefined && event.hasResponse !== true) return undefined;
      if (event.responseText !== undefined && typeof event.responseText !== "string") return undefined;
      const legacyResponseText = typeof event.responseText === "string" ? event.responseText.trim() : "";
      const hasResponse = event.hasResponse === true || legacyResponseText !== "";
      return {
        kind: "turn_settled",
        turnId: event.turnId,
        at: event.at,
        outcome: event.outcome,
        ...(hasResponse ? { hasResponse: true } : {}),
      };
    default:
      return undefined;
  }
}

/** Extract only Owner Operator's normalized, context-free activity entries from a Pi transcript. */
export function turnActivityEventsFromSessionEntries(entries: readonly unknown[]): TurnActivityEvent[] {
  const events: TurnActivityEvent[] = [];
  for (const candidate of entries) {
    if (!candidate || typeof candidate !== "object") continue;
    const entry = candidate as { type?: unknown; customType?: unknown; data?: unknown };
    if (entry.type !== "custom" || entry.customType !== OO_TURN_ACTIVITY_ENTRY) continue;
    const event = parseTurnActivityEvent(entry.data);
    if (event) events.push(event);
  }
  return events;
}

/**
 * Pi uses one generic `thinking` block for both hidden reasoning and provider summaries. Signed
 * OpenAI Responses summaries are safe to expose. Gemini 2.5+ thinking from Google's adapters is
 * also summary-only; every other provider's generic thinking content remains private.
 */
export function thinkingSummaryFromPiEvent(
  event: unknown,
  model?: { provider?: unknown; id?: unknown; reasoning?: unknown },
): string | undefined {
  if (!event || typeof event !== "object") return undefined;
  const update = event as { type?: unknown; contentIndex?: unknown; partial?: { content?: unknown } };
  if (update.type !== "thinking_end" || typeof update.contentIndex !== "number") return undefined;
  const content = update.partial?.content;
  if (!Array.isArray(content)) return undefined;
  const block = content[update.contentIndex] as {
    type?: unknown;
    thinking?: unknown;
    thinkingSignature?: unknown;
  } | undefined;
  if (block?.type !== "thinking" || typeof block.thinkingSignature !== "string") return undefined;
  try {
    const signed = JSON.parse(block.thinkingSignature) as { summary?: unknown };
    if (!Array.isArray(signed.summary)) return undefined;
    const summary = signed.summary
      .map((part) => part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
        ? (part as { text: string }).text
        : "")
      .filter(Boolean)
      .join("\n\n")
      .trim();
    return summary || undefined;
  } catch {
    // The Pi Google adapter identifies `thought: true` blocks as thought summaries; its
    // model catalog marks only thinking-capable Gemini models as `reasoning: true`.
    const summaryOnlyGemini = (model?.provider === "google" || model?.provider === "google-vertex")
      && typeof model.id === "string"
      && /^gemini(?:-live)?-/i.test(model.id)
      && model.reasoning === true;
    if (!summaryOnlyGemini || typeof block.thinking !== "string") return undefined;
    return block.thinking.trim() || undefined;
  }
}

/** Session-local adapter state. Core reduction remains pure; this owns only replay and expansion. */
export class TurnTraceStore {
  private traces = new Map<string, TurnTrace>();
  private order: string[] = [];
  private expanded = new Set<string>();
  // Replay-only settlement boundary. Nothing synthetic is appended to the saved transcript.
  private interruptedAt = new Map<string, number>();
  private lastEventAt = new Map<string, number>();

  static fromEvents(events: readonly TurnActivityEvent[]): TurnTraceStore {
    const store = new TurnTraceStore();
    for (const event of events) store.ingest(event);
    store.finishReplay();
    return store;
  }

  reset(events: readonly TurnActivityEvent[] = []): void {
    this.traces.clear();
    this.order = [];
    this.expanded.clear();
    this.interruptedAt.clear();
    this.lastEventAt.clear();
    for (const event of events) this.ingest(event);
    this.finishReplay();
  }

  ingest(event: TurnActivityEvent): boolean {
    let trace = this.traces.get(event.turnId);
    if (!trace) {
      if (event.kind === "turn_started") {
        const previousTurnId = this.order.at(-1);
        const previous = previousTurnId ? this.traces.get(previousTurnId) : undefined;
        if (previousTurnId && previous && previous.settledAt === undefined && !this.interruptedAt.has(previousTurnId)) {
          this.interruptedAt.set(previousTurnId, event.at);
        }
      }
      trace = createTurnTrace(event.turnId);
      this.traces.set(event.turnId, trace);
      this.order.push(event.turnId);
    }
    const next = applyTurnTraceEvent(trace, event);
    this.traces.set(event.turnId, next);
    this.lastEventAt.set(event.turnId, event.at);
    return next.actions.length > trace.actions.length;
  }

  private finishReplay(): void {
    const turnId = this.order.at(-1);
    const trace = turnId ? this.traces.get(turnId) : undefined;
    const at = turnId ? this.lastEventAt.get(turnId) : undefined;
    if (turnId && trace?.settledAt === undefined && at !== undefined) this.interruptedAt.set(turnId, at);
  }

  view(turnId: string): TurnTraceView | undefined {
    const trace = this.traces.get(turnId);
    const interruptedAt = this.interruptedAt.get(turnId);
    return trace
      ? deriveTurnTraceView(trace, {
        expanded: this.expanded.has(turnId),
        ...(interruptedAt !== undefined ? { interruptedAt } : {}),
      })
      : undefined;
  }

  toggleExpanded(turnId: string): void {
    const view = this.view(turnId);
    if (view?.kind !== "settled") return;
    if (this.expanded.has(turnId)) this.expanded.delete(turnId);
    else this.expanded.add(turnId);
  }

  visualAnchorTurnId(event: TurnActivityEvent): string | undefined {
    // The start anchor must exist before replay can derive an actionless interruption.
    return event.kind === "turn_started" ? event.turnId : undefined;
  }

  turnOptions(): Array<{ turnId: string; label: string }> {
    const visible = this.order.flatMap((turnId) => {
      const view = this.view(turnId);
      if (view?.kind === "settled") return [{ turnId, marker: view.expanded ? "▼" : "▶", summary: view.summary }];
      return [];
    });
    return visible.map(({ turnId, marker, summary }, index) => ({
      turnId,
      label: `${marker} Turn ${index + 1} · ${summary}`,
    }));
  }
}

export function renderTurnTraceText(view: TurnTraceView, theme: Theme): string {
  if (view.kind === "hidden") return "";
  if (view.kind === "interrupted") return theme.fg("warning", `! ${view.message}`);
  if (view.kind === "settled" && !view.expanded) {
    return [
      theme.fg("dim", `▶ ${view.summary} · expand trace`),
      ...(view.interruptionMessage ? [theme.fg("warning", `! ${view.interruptionMessage}`)] : []),
    ].join("\n");
  }

  const lines: string[] = [];
  if (view.kind === "settled") lines.push(theme.fg("dim", `▼ ${view.summary} · collapse trace`));
  for (const action of view.actions) {
    if (action.emphasis === "current") {
      lines.push(`${theme.fg("accent", action.marker)} ${theme.bold(theme.fg("text", action.label))}`);
    } else {
      lines.push(theme.fg("dim", `${action.marker} ${action.label}`));
    }
  }
  if (view.kind === "settled" && view.interruptionMessage) {
    lines.push(theme.fg("warning", `! ${view.interruptionMessage}`));
  }
  return lines.join("\n");
}

class TurnTraceComponent implements Component {
  constructor(
    private readonly store: TurnTraceStore,
    private readonly turnId: string,
    private readonly theme: Theme,
  ) {}

  render(width: number): string[] {
    const view = this.store.view(this.turnId);
    if (!view) return [];
    const value = renderTurnTraceText(view, this.theme);
    return value ? new Text(value, 0, 0).render(width) : [];
  }

  invalidate(): void {}
}

function finalAssistant(messages: readonly unknown[]): { stopReason?: unknown; content?: unknown } | undefined {
  return [...messages].reverse().find((message): message is { role: "assistant"; stopReason?: unknown; content?: unknown } =>
    !!message && typeof message === "object" && (message as { role?: unknown }).role === "assistant");
}

function hasAssistantText(message: { content?: unknown } | undefined): boolean {
  if (!Array.isArray(message?.content)) return false;
  return message.content.some((part) => part
    && typeof part === "object"
    && (part as { type?: unknown }).type === "text"
    && typeof (part as { text?: unknown }).text === "string"
    && (part as { text: string }).text.trim() !== "");
}

export function createTurnTraceExtension(options: { now?: () => number } = {}): ExtensionFactory {
  return (pi) => {
    const now = options.now ?? Date.now;
    const store = new TurnTraceStore();
    let activeTurnId: string | undefined;
    let turnCounter = 0;
    let eventCounter = 0;
    let pendingSettlement: { outcome: "completed" | "interrupted"; hasResponse?: true } | undefined;

    const append = (event: TurnActivityEvent): boolean => {
      const addedVisibleEntry = store.ingest(event);
      pi.appendEntry(OO_TURN_ACTIVITY_ENTRY, event);
      return addedVisibleEntry;
    };

    pi.registerEntryRenderer<TurnActivityEvent>(OO_TURN_ACTIVITY_ENTRY, (entry, _renderOptions, theme) => {
      const event = parseTurnActivityEvent(entry.data);
      if (!event) return undefined;
      // Pi rebuilds chat entries before firing session_start on extension reload. Replaying each
      // entry into the same store here makes that ordering deterministic; live duplicates are
      // harmless because the core reducer deduplicates semantic event IDs and is terminal-monotonic.
      store.ingest(event);
      const anchorTurnId = store.visualAnchorTurnId(event);
      return anchorTurnId ? new TurnTraceComponent(store, anchorTurnId, theme) : undefined;
    });

    pi.registerCommand("activity", {
      description: "Expand or collapse one historical turn's semantic activity trace.",
      handler: async (_args, ctx) => {
        const choices = store.turnOptions();
        if (choices.length === 0) {
          ctx.ui.notify("No settled activity traces in this session.", "info");
          return;
        }
        const selected = await ctx.ui.select("Turn activity", choices.map(({ label }) => label));
        const choice = choices.find(({ label }) => label === selected);
        if (!choice) return;
        store.toggleExpanded(choice.turnId);
        ctx.ui.setToolsExpanded(ctx.ui.getToolsExpanded());
      },
    });

    pi.on("session_start", (_event, ctx) => {
      store.reset(turnActivityEventsFromSessionEntries(ctx.sessionManager.getEntries()));
      activeTurnId = undefined;
      pendingSettlement = undefined;
    });

    pi.on("agent_start", (_event, ctx) => {
      // Pi may restart its agent loop for an automatic retry or queued continuation before the
      // outer prompt settles. Those attempts belong to the same owner turn and add no activity.
      if (activeTurnId) return;
      const startedAt = now();
      activeTurnId = `${ctx.sessionManager.getSessionId()}:${startedAt}:${turnCounter++}`;
      eventCounter = 0;
      pendingSettlement = undefined;
      ctx.ui.setWorkingVisible(true);
      append({ kind: "turn_started", turnId: activeTurnId, at: startedAt });
    });

    pi.on("message_update", (event, ctx) => {
      if (!activeTurnId) return;
      const summary = thinkingSummaryFromPiEvent(event.assistantMessageEvent, ctx.model);
      if (!summary) return;
      if (append({
        kind: "thinking_summary",
        turnId: activeTurnId,
        eventId: `${activeTurnId}:summary:${eventCounter++}`,
        at: now(),
        summary,
      })) ctx.ui.setWorkingVisible(false);
    });

    pi.on("tool_execution_start", (event, ctx) => {
      if (!activeTurnId || !semanticActionForTool(event.toolName)) return;
      if (append({
        kind: "tool",
        turnId: activeTurnId,
        eventId: `${activeTurnId}:tool:${event.toolCallId}`,
        at: now(),
        toolName: event.toolName,
      })) ctx.ui.setWorkingVisible(false);
    });

    pi.on("agent_end", (event) => {
      if (!activeTurnId) return;
      const assistant = finalAssistant(event.messages);
      const interrupted = assistant?.stopReason === "aborted"
        || assistant?.stopReason === "error"
        || assistant?.stopReason === "length";
      const hasResponse = hasAssistantText(assistant);
      pendingSettlement = {
        outcome: interrupted ? "interrupted" : "completed",
        ...(hasResponse ? { hasResponse: true } : {}),
      };
    });

    pi.on("agent_settled", (_event, ctx) => {
      if (!activeTurnId) return;
      const settlement = pendingSettlement ?? { outcome: "interrupted" as const };
      append({
        kind: "turn_settled",
        turnId: activeTurnId,
        at: now(),
        ...settlement,
      });
      activeTurnId = undefined;
      pendingSettlement = undefined;
      ctx.ui.setWorkingVisible(false);
    });
  };
}

export const turnTraceExtension = createTurnTraceExtension();
