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
assert.equal(thinkingSummaryFromPiEvent(harnessSummaryEvent), "Reviewing the reducer boundary", "OpenAI signed summaries remain visible");
const opaqueThinkingEvent = {
  ...harnessSummaryEvent,
  partial: { content: [{
    type: "thinking",
    thinking: "Reviewing the Gemini adapter boundary",
    thinkingSignature: "AQIDBA==",
  }] },
};
assert.equal(
  thinkingSummaryFromPiEvent(opaqueThinkingEvent, { provider: "google", id: "gemini-2.5-pro", reasoning: true }),
  "Reviewing the Gemini adapter boundary",
  "Gemini's summary-only thinking becomes timeline activity",
);
assert.equal(
  thinkingSummaryFromPiEvent(opaqueThinkingEvent, { provider: "google", id: "gemini-flash-latest", reasoning: true }),
  "Reviewing the Gemini adapter boundary",
  "Google's unversioned reasoning aliases retain Gemini summaries",
);
assert.equal(
  thinkingSummaryFromPiEvent(opaqueThinkingEvent, { provider: "anthropic", id: "claude-sonnet-4-5", reasoning: true }),
  undefined,
  "Anthropic opaque-signature thinking remains excluded",
);
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
  { kind: "turn_settled", turnId: "one", at: 2_000, outcome: "completed", hasResponse: true },
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

const replayWithOrphans = TurnTraceStore.fromEvents([
  { kind: "turn_started", turnId: "orphan-one", at: 5_000 },
  { kind: "tool", turnId: "orphan-one", eventId: "orphan-read", at: 5_100, toolName: "read" },
  { kind: "turn_started", turnId: "hidden-two", at: 6_000 },
  { kind: "turn_settled", turnId: "hidden-two", at: 6_100, outcome: "completed", hasResponse: true },
  { kind: "turn_started", turnId: "orphan-three", at: 7_000 },
  { kind: "tool", turnId: "orphan-three", eventId: "orphan-grep", at: 7_100, toolName: "grep" },
]);
assert.equal(replayWithOrphans.view("orphan-one")?.kind, "settled", "a later turn start interrupts an unterminated replay turn");
assert.equal(replayWithOrphans.view("orphan-three")?.kind, "settled", "end-of-transcript interrupts the final unterminated replay turn");
assert.deepEqual(replayWithOrphans.turnOptions().map(({ label }) => label), [
  "▶ Turn 1 · Worked for 1s · 1 action",
  "▶ Turn 2 · Worked for 0s · 1 action",
], "replayed interrupted turns are selectable and visible numbering does not skip hidden turns");
const reloadedOrphan = new TurnTraceStore();
const orphanAtReload: TurnActivityEvent[] = [
  { kind: "turn_started", turnId: "reload-orphan", at: 8_000 },
  { kind: "tool", turnId: "reload-orphan", eventId: "reload-read", at: 8_100, toolName: "read" },
];
for (const event of orphanAtReload) reloadedOrphan.ingest(event);
assert.equal(reloadedOrphan.view("reload-orphan")?.kind, "active");
reloadedOrphan.reset(orphanAtReload);
assert.equal(reloadedOrphan.view("reload-orphan")?.kind, "settled", "session reload derives an unterminated turn as interrupted");

const actionlessReplay = TurnTraceStore.fromEvents([
  { kind: "turn_started", turnId: "actionless-orphan", at: 9_000 },
]);
assert.equal(actionlessReplay.view("actionless-orphan")?.kind, "interrupted");
assert.deepEqual(actionlessReplay.turnOptions(), [], "actionless interrupted turns do not create a no-op /activity choice");

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
assert.deepEqual(turnActivityEventsFromSessionEntries([{
  type: "custom",
  customType: OO_TURN_ACTIVITY_ENTRY,
  data: { kind: "turn_settled", turnId: "legacy", at: 1, outcome: "completed", responseText: "Existing answer" },
}]), [{
  kind: "turn_settled",
  turnId: "legacy",
  at: 1,
  outcome: "completed",
  hasResponse: true,
}], "older full-text settlements replay through the minimal response-presence contract");

const theme = buildOoTheme();
const activeStore = new TurnTraceStore();
for (const event of firstTurn.slice(0, -1)) activeStore.ingest(event);
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
const workingVisibility: boolean[] = [];
const ctx = {
  sessionManager: { getSessionId: () => "session-1", getEntries: () => [] },
  ui: {
    async select(_title: string, choices: string[]): Promise<string> { return choices[0] ?? ""; },
    notify(): void {},
    setWidget(): void { widgetCalls += 1; },
    setWorkingVisible(visible: boolean): void { workingVisibility.push(visible); },
    setToolsExpanded(expanded: boolean): void { rawExpansionRefresh = expanded; },
    getToolsExpanded: () => false,
  },
};
const actionlessEntry = {
  type: "custom",
  customType: OO_TURN_ACTIVITY_ENTRY,
  data: { kind: "turn_started", turnId: "rendered-actionless", at: 9_500 } satisfies TurnActivityEvent,
};
const actionlessComponent = renderer?.(actionlessEntry, { expanded: false }, theme);
handlers.get("session_start")?.({ reason: "resume" }, {
  ...ctx,
  sessionManager: { ...ctx.sessionManager, getEntries: () => [actionlessEntry] },
});
assert.ok(
  actionlessComponent?.render(80).some((line: string) => stripVTControlCharacters(line).includes("Turn interrupted.")),
  "end-of-transcript hydration renders the concise fallback for an actionless orphan",
);
const followedActionlessEntries = [
  { type: "custom", customType: OO_TURN_ACTIVITY_ENTRY, data: {
    kind: "turn_started", turnId: "followed-actionless", at: 9_600,
  } satisfies TurnActivityEvent },
  { type: "custom", customType: OO_TURN_ACTIVITY_ENTRY, data: {
    kind: "turn_started", turnId: "following-hidden", at: 9_700,
  } satisfies TurnActivityEvent },
  { type: "custom", customType: OO_TURN_ACTIVITY_ENTRY, data: {
    kind: "turn_settled", turnId: "following-hidden", at: 9_800, outcome: "completed", hasResponse: true,
  } satisfies TurnActivityEvent },
];
const followedComponents = followedActionlessEntries
  .map((entry) => renderer?.(entry, { expanded: false }, theme))
  .filter((component) => component !== undefined);
handlers.get("session_start")?.({ reason: "resume" }, {
  ...ctx,
  sessionManager: { ...ctx.sessionManager, getEntries: () => followedActionlessEntries },
});
const followedFallbacks = followedComponents.filter((component) =>
  component.render(80).some((line: string) => stripVTControlCharacters(line).includes("Turn interrupted."))
);
assert.equal(followedFallbacks.length, 1, "a following turn start renders one concise orphan fallback");
handlers.get("session_start")?.({ reason: "startup" }, ctx);
handlers.get("agent_start")?.({ type: "agent_start" }, ctx);
const liveAnchorEntry = { type: "custom", customType: OO_TURN_ACTIVITY_ENTRY, data: appended[0]?.data };
const liveComponent = renderer?.(liveAnchorEntry, { expanded: false }, theme);
assert.deepEqual(workingVisibility, [true], "the working indicator remains visible before the first semantic action");
handlers.get("message_update")?.({ assistantMessageEvent: {
  ...harnessSummaryEvent,
  partial: { content: [{ type: "thinking", thinking: "private reasoning" }] },
} }, ctx);
assert.deepEqual(workingVisibility, [true], "hidden reasoning does not create dead air by hiding the indicator");
handlers.get("message_update")?.({ assistantMessageEvent: harnessSummaryEvent }, ctx);
assert.deepEqual(workingVisibility, [true, false], "the first visible timeline entry replaces the working indicator");
handlers.get("message_update")?.({ assistantMessageEvent: {
  ...harnessSummaryEvent,
  partial: { content: [{ type: "thinking", thinking: "private reasoning" }] },
} }, ctx);
handlers.get("tool_execution_start")?.({ toolCallId: "known", toolName: "read", args: { path: "/secret/path" } }, ctx);
handlers.get("tool_execution_start")?.({ toolCallId: "unknown", toolName: "unhelpful_internal", args: { password: "secret" } }, ctx);
assert.deepEqual(appended.map(({ data }) => data.kind), ["turn_started", "thinking_summary", "tool"]);
assert.ok(!JSON.stringify(appended).includes("/secret/path") && !JSON.stringify(appended).includes("private reasoning"), "the Pi adapter persists no args or hidden thinking");
assert.equal(widgetCalls, 0, "live activity stays in its transcript anchor instead of duplicating into a widget");

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
const settlement = appended.at(-1)?.data;
assert.deepEqual(settlement?.kind === "turn_settled" ? settlement : undefined, {
  kind: "turn_settled",
  turnId: settlement?.turnId,
  at: settlement?.at,
  outcome: "completed",
  hasResponse: true,
}, "settlement persists only whether owner-facing response text exists");
assert.ok(liveComponent?.render(80).some((line: string) => stripVTControlCharacters(line).includes("Worked for")), "settlement updates the existing trace anchor");
assert.ok(activityCommand, "one command owns per-turn semantic expansion");
await activityCommand?.handler("", ctx);
assert.ok(liveComponent?.render(80).some((line: string) => stripVTControlCharacters(line).includes("collapse trace")), "/activity expands the selected turn in place");
assert.equal(rawExpansionRefresh, false, "semantic expansion does not enable raw tool detail");
handlers.get("agent_start")?.({ type: "agent_start" }, ctx);
assert.equal(workingVisibility.at(-1), true, "the next owner turn restores the working indicator");

process.stdout.write("ok — Pi TurnTrace adapter: signed summaries, persistence/replay, timeline rendering, per-turn expansion\n");
