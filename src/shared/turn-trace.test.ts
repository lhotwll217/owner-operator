import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import type { TurnActivityEvent } from "@owner-operator/core/activity";
import { visibleWidth } from "@earendil-works/pi-tui";
import { buildOoTheme } from "./oo-presentation";
import {
  OO_TURN_ACTIVITY_ENTRY,
  TurnTraceStore,
  createTurnTraceExtension,
  renderTurnTraceText,
  thinkingSummaryFromPiEvent,
  turnActivityEventsFromSessionEntries,
} from "./turn-trace";

const harnessSummaryEvent = {
  type: "thinking_end",
  contentIndex: 0,
  content: "must not be trusted as the source",
  partial: {
    content: [{
      type: "thinking",
      thinking: "must not be trusted as the source",
      thinkingSignature: JSON.stringify({ summary: [{ type: "summary_text", text: "Reviewing the reducer boundary" }] }),
    }],
  },
};
assert.equal(thinkingSummaryFromPiEvent(harnessSummaryEvent), "Reviewing the reducer boundary");
assert.equal(thinkingSummaryFromPiEvent({
  ...harnessSummaryEvent,
  partial: { content: [{ type: "thinking", thinking: "hidden chain of thought" }] },
}), undefined, "generic thinking without a signed harness summary is never rendered");
assert.equal(thinkingSummaryFromPiEvent({
  ...harnessSummaryEvent,
  partial: { content: [{ type: "thinking", thinking: "hidden", thinkingSignature: JSON.stringify({ content: [{ text: "hidden" }] }) }] },
}), undefined, "reasoning content is not treated as a summary");

const firstTurn: TurnActivityEvent[] = [
  { kind: "turn_started", turnId: "one", at: 0 },
  { kind: "thinking_summary", turnId: "one", eventId: "one-summary", at: 100, summary: "Inspecting the adapter" },
  { kind: "tool", turnId: "one", eventId: "one-tool", at: 200, toolName: "read" },
  { kind: "turn_settled", turnId: "one", at: 2_000, outcome: "completed", responseText: "Done." },
];
const secondTurn: TurnActivityEvent[] = [
  { kind: "turn_started", turnId: "two", at: 3_000 },
  { kind: "tool", turnId: "two", eventId: "two-tool", at: 3_100, toolName: "grep" },
  { kind: "turn_settled", turnId: "two", at: 4_000, outcome: "completed" },
];
const liveStore = new TurnTraceStore();
for (const event of [...firstTurn, ...secondTurn]) liveStore.ingest(event);
const replayStore = TurnTraceStore.fromEvents([...firstTurn, ...secondTurn]);
assert.deepEqual(replayStore.view("one"), liveStore.view("one"), "adapter replay and live ingestion share the core reducer");

liveStore.toggleExpanded("one");
const expandedOne = liveStore.view("one");
const compactTwo = liveStore.view("two");
assert.equal(expandedOne?.kind, "settled");
assert.equal(expandedOne?.kind === "settled" && expandedOne.expanded, true);
assert.equal(compactTwo?.kind === "settled" && compactTwo.expanded, false, "expansion belongs to one turn");

const entries = [...firstTurn, ...secondTurn].map((event, index) => ({
  type: "custom",
  id: `entry-${index}`,
  customType: OO_TURN_ACTIVITY_ENTRY,
  data: event,
}));
assert.deepEqual(turnActivityEventsFromSessionEntries([
  { type: "message", message: { role: "assistant", content: "ignored" } },
  ...entries,
  { type: "custom", customType: OO_TURN_ACTIVITY_ENTRY, data: { kind: "tool", args: "invalid" } },
]), [...firstTurn, ...secondTurn], "saved transcript replay accepts only valid normalized activity entries");

const theme = buildOoTheme();
const activeStore = TurnTraceStore.fromEvents(firstTurn.slice(0, -1));
const activeView = activeStore.view("one");
assert.ok(activeView);
const activeText = stripVTControlCharacters(renderTurnTraceText(activeView, theme));
assert.equal(activeText, "│ Inspecting the adapter\n● Reading files", "timeline rail matches approved variant C");
const settledView = replayStore.view("one");
assert.ok(settledView);
assert.equal(stripVTControlCharacters(renderTurnTraceText(settledView, theme)), "▶ Worked for 2s · 2 actions · expand trace");

const narrow = renderTurnTraceText(activeView, theme);
const { Text } = await import("@earendil-works/pi-tui");
for (const line of new Text(narrow).render(24)) {
  assert.ok(visibleWidth(line) <= 24, "timeline wraps within a narrow terminal");
}

type Handler = (event: any, ctx: any) => void;
const handlers = new Map<string, Handler>();
const appended: Array<{ customType: string; data: TurnActivityEvent }> = [];
let renderer: ((entry: any, options: any, theme: any) => any) | undefined;
let activityCommand: { handler(args: string, ctx: any): Promise<void> } | undefined;
const extension = createTurnTraceExtension({ now: (() => { let value = 10_000; return () => value += 100; })() });
extension({
  on(name: string, handler: Handler): void { handlers.set(name, handler); },
  appendEntry(customType: string, data: TurnActivityEvent): void { appended.push({ customType, data }); },
  registerEntryRenderer(_type: string, value: typeof renderer): void { renderer = value; },
  registerCommand(_name: string, value: typeof activityCommand): void { activityCommand = value; },
} as any);
let widgetCalls = 0;
let rawExpansionRefresh: boolean | undefined;
const ctx = {
  sessionManager: { getSessionId: () => "session-1", getEntries: () => [] },
  ui: {
    async select(_title: string, choices: string[]): Promise<string> { return choices[0] ?? ""; },
    notify(): void {},
    setWidget(): void { widgetCalls += 1; },
    setWorkingVisible(): void {},
    setToolsExpanded(expanded: boolean): void { rawExpansionRefresh = expanded; },
    getToolsExpanded: () => false,
  },
};
handlers.get("session_start")?.({ reason: "startup" }, ctx);
handlers.get("agent_start")?.({ type: "agent_start" }, ctx);
handlers.get("message_update")?.({ assistantMessageEvent: harnessSummaryEvent }, ctx);
handlers.get("message_update")?.({ assistantMessageEvent: {
  ...harnessSummaryEvent,
  partial: { content: [{ type: "thinking", thinking: "private reasoning" }] },
} }, ctx);
handlers.get("tool_execution_start")?.({ toolCallId: "known", toolName: "read", args: { path: "/secret/path" } }, ctx);
handlers.get("tool_execution_start")?.({ toolCallId: "unknown", toolName: "unhelpful_internal", args: { password: "secret" } }, ctx);
assert.deepEqual(appended.map(({ data }) => data.kind), ["turn_started", "thinking_summary", "tool"]);
assert.ok(!JSON.stringify(appended).includes("/secret/path") && !JSON.stringify(appended).includes("private reasoning"), "the Pi adapter persists no args or hidden thinking");
assert.equal(widgetCalls, 0, "live activity stays in its transcript anchor instead of duplicating into a widget");

const semanticEntry = { type: "custom", customType: OO_TURN_ACTIVITY_ENTRY, data: appended[1]?.data };
const liveComponent = renderer?.(semanticEntry, { expanded: false }, theme);
assert.ok(liveComponent?.render(80).some((line: string) => stripVTControlCharacters(line).includes("Reviewing the reducer boundary")), "the live anchor renders retained activity");

handlers.get("agent_end")?.({ messages: [{
  role: "assistant",
  content: [{ type: "text", text: "routine provider failure" }],
  stopReason: "error",
}] }, ctx);
handlers.get("agent_start")?.({ type: "agent_start" }, ctx);
assert.equal(appended.filter(({ data }) => data.kind === "turn_started").length, 1, "a retry stays inside the same owner turn");
assert.notEqual(appended.at(-1)?.data.kind, "turn_settled", "routine retry failures remain hidden");

handlers.get("agent_end")?.({ messages: [{
  role: "assistant",
  content: [{ type: "thinking", thinking: "hidden" }, { type: "text", text: "Final answer" }],
  stopReason: "stop",
}] }, ctx);
assert.notEqual(appended.at(-1)?.data.kind, "turn_settled", "agent_end alone does not expose a routine retry/failure");
handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);
assert.equal(appended.at(-1)?.data.kind, "turn_settled");
assert.ok(liveComponent?.render(80).some((line: string) => stripVTControlCharacters(line).includes("Worked for")), "settlement updates the existing trace anchor");
assert.ok(activityCommand, "one command owns per-turn semantic expansion");
await activityCommand?.handler("", ctx);
assert.ok(liveComponent?.render(80).some((line: string) => stripVTControlCharacters(line).includes("collapse trace")), "/activity expands the selected turn in place");
assert.equal(rawExpansionRefresh, false, "semantic expansion does not enable raw tool detail");

process.stdout.write("ok — Pi TurnTrace adapter: signed summaries, persistence/replay, timeline rendering, per-turn expansion\n");
