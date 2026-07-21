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
      if (event.responseText !== undefined && typeof event.responseText !== "string") return undefined;
      return {
        kind: "turn_settled",
        turnId: event.turnId,
        at: event.at,
        outcome: event.outcome,
        ...(event.responseText ? { responseText: event.responseText } : {}),
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
 * Pi uses one generic `thinking` block for both hidden reasoning and provider summaries. Only a
 * signed OpenAI Responses item with a non-empty `summary` is safe to expose; generic thinking
 * content and the event's convenience `content` field are deliberately ignored.
 */
export function thinkingSummaryFromPiEvent(event: unknown): string | undefined {
  if (!event || typeof event !== "object") return undefined;
  const update = event as { type?: unknown; contentIndex?: unknown; partial?: { content?: unknown } };
  if (update.type !== "thinking_end" || typeof update.contentIndex !== "number") return undefined;
  const content = update.partial?.content;
  if (!Array.isArray(content)) return undefined;
  const block = content[update.contentIndex] as { type?: unknown; thinkingSignature?: unknown } | undefined;
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
    return undefined;
  }
}

/** Session-local adapter state. Core reduction remains pure; this owns only replay and expansion. */
export class TurnTraceStore {
  private traces = new Map<string, TurnTrace>();
  private order: string[] = [];
  private firstAction = new Map<string, string>();
  private expanded = new Set<string>();

  static fromEvents(events: readonly TurnActivityEvent[]): TurnTraceStore {
    const store = new TurnTraceStore();
    for (const event of events) store.ingest(event);
    return store;
  }

  reset(events: readonly TurnActivityEvent[] = []): void {
    this.traces.clear();
    this.order = [];
    this.firstAction.clear();
    this.expanded.clear();
    for (const event of events) this.ingest(event);
  }

  ingest(event: TurnActivityEvent): void {
    let trace = this.traces.get(event.turnId);
    if (!trace) {
      trace = createTurnTrace(event.turnId);
      this.traces.set(event.turnId, trace);
      this.order.push(event.turnId);
    }
    const next = applyTurnTraceEvent(trace, event);
    this.traces.set(event.turnId, next);
    if (next.actions.length > trace.actions.length && "eventId" in event && !this.firstAction.has(event.turnId)) {
      this.firstAction.set(event.turnId, event.eventId);
    }
  }

  view(turnId: string): TurnTraceView | undefined {
    const trace = this.traces.get(turnId);
    return trace ? deriveTurnTraceView(trace, { expanded: this.expanded.has(turnId) }) : undefined;
  }

  toggleExpanded(turnId: string): void {
    const view = this.view(turnId);
    if (view?.kind !== "settled") return;
    if (this.expanded.has(turnId)) this.expanded.delete(turnId);
    else this.expanded.add(turnId);
  }

  isVisualAnchor(event: TurnActivityEvent): boolean {
    if ("eventId" in event && this.firstAction.get(event.turnId) === event.eventId) return true;
    return event.kind === "turn_settled" && this.view(event.turnId)?.kind === "interrupted";
  }

  turnOptions(): Array<{ turnId: string; label: string }> {
    return this.order.flatMap((turnId, index) => {
      const view = this.view(turnId);
      if (view?.kind !== "settled") return [];
      return [{ turnId, label: `${view.expanded ? "▼" : "▶"} Turn ${index + 1} · ${view.summary}` }];
    });
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

function textFromAssistant(message: { content?: unknown } | undefined): string | undefined {
  if (!Array.isArray(message?.content)) return undefined;
  const text = message.content
    .map((part) => part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string"
      ? (part as { text: string }).text
      : "")
    .join("")
    .trim();
  return text || undefined;
}

export function createTurnTraceExtension(options: { now?: () => number } = {}): ExtensionFactory {
  return (pi) => {
    const now = options.now ?? Date.now;
    const store = new TurnTraceStore();
    let activeTurnId: string | undefined;
    let turnCounter = 0;
    let eventCounter = 0;
    let pendingSettlement: { outcome: "completed" | "interrupted"; responseText?: string } | undefined;

    const append = (event: TurnActivityEvent): void => {
      store.ingest(event);
      pi.appendEntry(OO_TURN_ACTIVITY_ENTRY, event);
    };

    pi.registerEntryRenderer<TurnActivityEvent>(OO_TURN_ACTIVITY_ENTRY, (entry, _renderOptions, theme) => {
      const event = parseTurnActivityEvent(entry.data);
      if (!event) return undefined;
      // Pi rebuilds chat entries before firing session_start on extension reload. Replaying each
      // entry into the same store here makes that ordering deterministic; live duplicates are
      // harmless because the core reducer deduplicates semantic event IDs and is terminal-monotonic.
      store.ingest(event);
      if (!store.isVisualAnchor(event)) return undefined;
      return new TurnTraceComponent(store, event.turnId, theme);
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
      ctx.ui.setWorkingVisible(false);
      append({ kind: "turn_started", turnId: activeTurnId, at: startedAt });
    });

    pi.on("message_update", (event) => {
      if (!activeTurnId) return;
      const summary = thinkingSummaryFromPiEvent(event.assistantMessageEvent);
      if (!summary) return;
      append({
        kind: "thinking_summary",
        turnId: activeTurnId,
        eventId: `${activeTurnId}:summary:${eventCounter++}`,
        at: now(),
        summary,
      });
    });

    pi.on("tool_execution_start", (event) => {
      if (!activeTurnId || !semanticActionForTool(event.toolName)) return;
      append({
        kind: "tool",
        turnId: activeTurnId,
        eventId: `${activeTurnId}:tool:${event.toolCallId}`,
        at: now(),
        toolName: event.toolName,
      });
    });

    pi.on("agent_end", (event) => {
      if (!activeTurnId) return;
      const assistant = finalAssistant(event.messages);
      const interrupted = assistant?.stopReason === "aborted"
        || assistant?.stopReason === "error"
        || assistant?.stopReason === "length";
      const responseText = textFromAssistant(assistant);
      pendingSettlement = {
        outcome: interrupted ? "interrupted" : "completed",
        ...(responseText ? { responseText } : {}),
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
