import assert from "node:assert/strict";
import {
  applyTurnTraceEvent,
  createTurnTrace,
  deriveTurnTraceView,
  replayTurnTrace,
  semanticActionForTool,
  type TurnActivityEvent,
} from "@owner-operator/core/activity";

const events: TurnActivityEvent[] = [
  { kind: "turn_started", turnId: "turn-1", at: 1_000 },
  { kind: "thinking_summary", turnId: "turn-1", eventId: "summary-1", at: 1_100, summary: "Inspecting the launcher" },
  { kind: "tool", turnId: "turn-1", eventId: "tool-1", at: 1_200, toolName: "read" },
  { kind: "tool", turnId: "turn-1", eventId: "unknown-1", at: 1_300, toolName: "internal_retry" },
  { kind: "tool", turnId: "turn-1", eventId: "tool-2", at: 1_400, toolName: "grep" },
];

let live = createTurnTrace("turn-1");
for (const event of events) live = applyTurnTraceEvent(live, event);

const active = deriveTurnTraceView(live);
assert.equal(active.kind, "active");
assert.deepEqual(active.actions.map(({ label }) => label), [
  "Inspecting the launcher",
  "Reading files",
  "Searching code",
], "retained summaries and allowlisted tools stay in source order; unknown tools are omitted");
assert.deepEqual(active.actions.map(({ marker, emphasis }) => ({ marker, emphasis })), [
  { marker: "│", emphasis: "muted" },
  { marker: "│", emphasis: "muted" },
  { marker: "●", emphasis: "current" },
], "the current action has both a distinct marker and emphasis; prior actions are muted");

assert.equal(semanticActionForTool("bash"), "Running commands");
assert.equal(semanticActionForTool("not_registered"), undefined, "the deterministic map is an allowlist");

const tenEvents: TurnActivityEvent[] = [
  { kind: "turn_started", turnId: "turn-10", at: 10_000 },
  ...Array.from({ length: 10 }, (_, index): TurnActivityEvent => ({
    kind: "thinking_summary",
    turnId: "turn-10",
    eventId: `summary-${index}`,
    at: 10_100 + index,
    summary: `Action ${index + 1}`,
  })),
];
const tenActive = replayTurnTrace(tenEvents);
assert.equal(tenActive.kind, "active");
assert.equal(tenActive.actions.length, 10, "active turns retain every semantic action without a fold threshold");

const settledEvents: TurnActivityEvent[] = [
  ...tenEvents,
  {
    kind: "turn_settled",
    turnId: "turn-10",
    at: 18_000,
    outcome: "completed",
    responseText: "The final response remains visible.",
  },
];
const compact = replayTurnTrace(settledEvents);
assert.deepEqual(compact, {
  kind: "settled",
  turnId: "turn-10",
  expanded: false,
  durationMs: 8_000,
  actionCount: 10,
  summary: "Worked for 8s · 10 actions",
  actions: [],
  responseText: "The final response remains visible.",
}, "settlement collapses to duration/action count without losing the final response");

const expanded = replayTurnTrace(settledEvents, { expanded: true });
assert.equal(expanded.kind, "settled");
assert.deepEqual(expanded.actions.map(({ label }) => label), Array.from({ length: 10 }, (_, index) => `Action ${index + 1}`));
assert.ok(expanded.actions.every(({ marker, emphasis }) => marker === "│" && emphasis === "muted"), "settled expansion restores the trace without claiming a current action");
assert.deepEqual(
  replayTurnTrace([...settledEvents, { kind: "tool", turnId: "turn-10", eventId: "late", at: 19_000, toolName: "write" }]),
  compact,
  "late events cannot reopen or mutate a settled trace",
);

assert.deepEqual(
  replayTurnTrace(events),
  deriveTurnTraceView(live),
  "saved replay and incrementally ingested live events produce the same view",
);

const sensitive = replayTurnTrace([
  { kind: "turn_started", turnId: "sensitive", at: 0 },
  {
    kind: "tool",
    turnId: "sensitive",
    eventId: "tool-sensitive",
    at: 1,
    toolName: "read",
    args: { path: "/Users/person/secret.txt", token: "credential-value" },
    result: "raw result body",
    error: "technical failure",
    retry: "retry chatter",
  } as TurnActivityEvent,
]);
const renderedSensitive = JSON.stringify(sensitive);
for (const hidden of ["/Users/person/secret.txt", "credential-value", "raw result body", "technical failure", "retry chatter"]) {
  assert.ok(!renderedSensitive.includes(hidden), `compact activity excludes ${hidden}`);
}
assert.ok(!JSON.stringify(replayTurnTrace([
  { kind: "turn_started", turnId: "control", at: 0 },
  { kind: "thinking_summary", turnId: "control", eventId: "summary", at: 1, summary: "Reviewing\u001b[2J output" },
])).includes("\\u001b"), "harness summaries cannot inject terminal control sequences");

assert.deepEqual(replayTurnTrace([
  { kind: "turn_started", turnId: "short", at: 0 },
  { kind: "turn_settled", turnId: "short", at: 250, outcome: "completed", responseText: "Done." },
]), {
  kind: "hidden",
  turnId: "short",
  responseText: "Done.",
}, "short turns with no semantic actions do not manufacture an activity summary");

assert.deepEqual(replayTurnTrace([
  { kind: "turn_started", turnId: "partial", at: 0 },
  { kind: "turn_settled", turnId: "partial", at: 2_000, outcome: "interrupted", responseText: "Partial answer" },
]), {
  kind: "hidden",
  turnId: "partial",
  responseText: "Partial answer",
}, "interrupted turns retain partial output without adding technical noise");

assert.deepEqual(replayTurnTrace([
  { kind: "turn_started", turnId: "fallback", at: 0 },
  { kind: "turn_settled", turnId: "fallback", at: 2_000, outcome: "interrupted" },
]), {
  kind: "interrupted",
  turnId: "fallback",
  message: "Turn interrupted.",
}, "an interrupted empty turn gets one concise fallback");

assert.deepEqual(replayTurnTrace([
  { kind: "turn_started", turnId: "worked-then-interrupted", at: 0 },
  { kind: "tool", turnId: "worked-then-interrupted", eventId: "read", at: 100, toolName: "read" },
  { kind: "turn_settled", turnId: "worked-then-interrupted", at: 2_000, outcome: "interrupted" },
]), {
  kind: "settled",
  turnId: "worked-then-interrupted",
  expanded: false,
  durationMs: 2_000,
  actionCount: 1,
  summary: "Worked for 2s · 1 action",
  actions: [],
  interruptionMessage: "Turn interrupted.",
}, "an interrupted turn with activity retains its compact trace and explains the outcome");

process.stdout.write("ok — TurnTrace core: ordered live activity, settlement, expansion, replay, privacy, interruption\n");
