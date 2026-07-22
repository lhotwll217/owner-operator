// Unit: the OO presentation seam. We test external behaviour — the rendered strings, the
// palette data, the raw-detail/thinking shim — not pi's live TUI (which
// needs a real TTY and isn't snapshot-testable in this hermetic runner). The shim tests render
// pi's REAL AssistantMessageComponent, so a pi rename/reshape fails here loudly instead of
// silently letting the dump back into the scrollback. Same assertion style as
// src/cli/oo-args.test.ts.
import assert from "node:assert";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { AgentRunStatus } from "@owner-operator/core";
import {
  OO_NAME,
  buildOoTheme,
  elapsedLabel,
  formatAgentRunRow,
  isAssistantMessageRow,
  isToolExecutionRow,
  ooInteractiveOptions,
  ooMarker,
  ooPalette,
  quietOoInteractiveMode,
} from "./oo-presentation";

// 1. The identity marker reads as Owner Operator and carries NO pi branding.
const marker = ooMarker("1.2.3");
assert.equal(marker, "Owner Operator v1.2.3", "marker is the OO name + version");
assert.doesNotMatch(marker, /\bpi\b/i, "marker has no 'pi' branding");
assert.doesNotMatch(marker, /π/, "marker has no pi glyph");
assert.doesNotMatch(OO_NAME, /\bpi\b/i, "the surface name has no 'pi' branding");
assert.match(marker, /^Owner Operator v/, "marker leads with the OO identity");

// 2. The palette exposes the deliberate OO accent + muted greys, and builds a complete theme.
assert.equal(ooPalette.accent, "#b98a4b", "one deliberate OO accent");
assert.equal(ooPalette.muted, "#8b9099", "muted grey");
assert.equal(ooPalette.dim, "#5b606b", "dim grey");
const theme = buildOoTheme();
assert.equal(theme.name, "owner-operator", "the theme is OO's own");
// A complete color map means no token throws — accent/muted/dim/text/toolTitle all resolve.
for (const color of ["accent", "muted", "dim", "text", "toolTitle", "success", "error"] as const) {
  assert.doesNotThrow(() => theme.fg(color, "x"), `theme has the ${color} token`);
}

// 3. The zero-dump predicates match pi's components by class name — the guard that keeps the
//    wall of tool output and the reasoning dump out of scrollback. If pi renames a component,
//    this file (and the real-component render test below) is where it fails loudly.
assert.ok(isToolExecutionRow({ constructor: { name: "ToolExecutionComponent" } }), "matches the pi tool row");
assert.ok(!isToolExecutionRow({ constructor: { name: "AssistantMessageComponent" } }), "leaves assistant messages alone");
assert.ok(!isToolExecutionRow(null), "null is not a tool row");
assert.ok(!isToolExecutionRow(undefined), "undefined is not a tool row");
assert.ok(isAssistantMessageRow({ constructor: { name: "AssistantMessageComponent" } }), "matches the pi assistant row");
assert.ok(!isAssistantMessageRow({ constructor: { name: "ToolExecutionComponent" } }), "tool rows are not assistant rows");
assert.ok(!isAssistantMessageRow(null), "null is not an assistant row");

// 4. quietOoInteractiveMode keeps generic raw tool rows hidden until Pi's separate expansion,
//    while delegated-run rows and non-tool content remain visible and startup notices are silent.
//    A fake mode stands in for pi's InteractiveMode (structural, no pi import) — mirrors how pi
//    calls `chatContainer.addChild(component)` and `showPackageUpdateNotification(...)`.
const children: unknown[] = [];
let pkgNoticeShown = false;
let verNoticeShown = false;
let expansionRenders = 0;
const fakeMode = {
  chatContainer: { children, addChild: (c: unknown) => void children.push(c) },
  ui: { requestRender: () => { expansionRenders += 1; } },
  toggleToolOutputExpansion(): void {},
  showPackageUpdateNotification: () => { pkgNoticeShown = true; },
  showNewVersionNotification: () => { verNoticeShown = true; },
};
quietOoInteractiveMode(fakeMode);
const toolRow = (toolName: string, rendered = `RAW ${toolName} /secret/path result body`) => ({
  constructor: { name: "ToolExecutionComponent" },
  toolName,
  expanded: false,
  setExpanded(expanded: boolean): void { this.expanded = expanded; },
  render(): string[] { return [rendered]; },
});
const genericToolRow = toolRow("read");
const delegateToolRow = toolRow("delegate_agent", "claude-code · research · running · 30s");
const manageRunToolRow = toolRow("manage_agent_run", "codex · audit · completed · 1m");
class CustomEntryComponent {
  entry = { customType: "owner-operator.turn-activity.v1" };
  expanded = false;
  setExpanded(expanded: boolean): void { this.expanded = expanded; }
}
const turnTraceRow = new CustomEntryComponent();
fakeMode.chatContainer.addChild(genericToolRow);
fakeMode.chatContainer.addChild(delegateToolRow);
fakeMode.chatContainer.addChild(manageRunToolRow);
fakeMode.chatContainer.addChild(turnTraceRow);
fakeMode.chatContainer.addChild({ constructor: { name: "AssistantMessageComponent" } });
fakeMode.chatContainer.addChild({ constructor: { name: "Text" } });
assert.equal(children.length, 6, "raw tool rows retain their source position beside non-tool rows");
assert.ok(children.includes(genericToolRow), "the raw-detail component remains available for explicit expansion");
assert.deepEqual(genericToolRow.render(), [], "raw arguments and results render zero lines by default");
genericToolRow.setExpanded(true);
assert.deepEqual(genericToolRow.render(), ["RAW read /secret/path result body"], "raw detail uses Pi's separate explicit expansion");
genericToolRow.expanded = false; // Pi's updateDisplay mutates internal fields, but not our gate.
assert.deepEqual(genericToolRow.render(), ["RAW read /secret/path result body"], "tool updates cannot bypass an explicit raw-detail expansion");
genericToolRow.setExpanded(false);
assert.deepEqual(genericToolRow.render(), [], "the separate expansion closes raw detail again");
assert.deepEqual(delegateToolRow.render(), ["claude-code · research · running · 30s"], "the compact delegated-run snapshot stays visible by default");
assert.deepEqual(manageRunToolRow.render(), ["codex · audit · completed · 1m"], "the compact run-management snapshot stays visible by default");
assert.doesNotMatch(delegateToolRow.render().join("\n") + manageRunToolRow.render().join("\n"), /RAW|result body|failure|retry/i);
fakeMode.toggleToolOutputExpansion();
assert.equal(turnTraceRow.expanded, true, "the first Pi expansion reveals the semantic turn trace");
assert.deepEqual(genericToolRow.render(), [], "semantic expansion does not reveal raw tool detail");
fakeMode.toggleToolOutputExpansion();
assert.deepEqual(genericToolRow.render(), ["RAW read /secret/path result body"], "the second Pi expansion explicitly reveals raw detail");
fakeMode.toggleToolOutputExpansion();
assert.equal(turnTraceRow.expanded, false, "the third Pi expansion returns to compact turns");
assert.deepEqual(genericToolRow.render(), [], "returning to compact hides raw detail");
assert.equal(expansionRenders, 3);
fakeMode.showPackageUpdateNotification();
fakeMode.showNewVersionNotification();
assert.ok(!pkgNoticeShown && !verNoticeShown, "startup update notices are silenced");
// Duck-typed and defensive: a mode without the expected shape must not throw.
assert.doesNotThrow(() => quietOoInteractiveMode({}), "no chatContainer → no-op");
assert.doesNotThrow(() => quietOoInteractiveMode(null), "null mode → no-op");

// 8. Render-level: the shim strips thinking from pi's REAL AssistantMessageComponent, on both
//    of pi's paths. This is the regression test for the blank-line bug: hideThinkingBlock plus
//    an empty label used to render an ANSI-wrapped "" — a blank padded line + spacer per
//    reasoning turn. Under the shim, reasoning must render NOTHING.
//    (Deep file-URL import: pi's exports map hides dist internals, and these are exactly the
//    internals the shim patches — if pi moves them, this import failing IS the loud signal.)
initTheme("dark"); // the component reads pi's global theme; any built-in theme will do
const { AssistantMessageComponent } = (await import(
  new URL(
    "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/assistant-message.js",
    import.meta.url,
  ).href
)) as {
  AssistantMessageComponent: new (
    message?: unknown,
    hideThinkingBlock?: boolean,
    markdownTheme?: unknown,
    hiddenThinkingLabel?: string,
  ) => { render(width: number): string[]; updateContent(message: unknown): void };
};

const shimmedChildren: unknown[] = [];
const shimmedMode = { chatContainer: { children: shimmedChildren, addChild: (c: unknown) => void shimmedChildren.push(c) } };
quietOoInteractiveMode(shimmedMode);
const mkAssistant = (content: unknown[]) => ({ role: "assistant", content, stopReason: "stop" });
const THINKING = { type: "thinking", thinking: "secret reasoning that must never render" };
const ANSWER = { type: "text", text: "The answer." };

// Baseline: what a thinking-free assistant message renders like (the production config:
// hideThinkingBlock on, label blanked).
const baseline = new AssistantMessageComponent(mkAssistant([ANSWER]), true, undefined, "").render(80);
assert.ok(baseline.some((l) => l.includes("The answer.")), "sanity: the baseline renders its text");

// Streaming path: pi adds the component empty, then streams updateContent into it.
const streaming = new AssistantMessageComponent(undefined, true, undefined, "");
shimmedMode.chatContainer.addChild(streaming);
streaming.updateContent(mkAssistant([THINKING]));
assert.deepEqual(streaming.render(80), [], "a thinking-only update renders ZERO lines — no label, no blanks");
streaming.updateContent(mkAssistant([THINKING, ANSWER]));
assert.deepEqual(streaming.render(80), baseline, "thinking + text renders exactly like text alone");

// Finalized path (resume/rebuild): pi constructs WITH the message — the constructor renders the
// thinking before addChild ever runs — so the shim must re-render it clean at add time.
const finalized = new AssistantMessageComponent(mkAssistant([THINKING, ANSWER]), true, undefined, "");
shimmedMode.chatContainer.addChild(finalized);
assert.deepEqual(finalized.render(80), baseline, "an already-rendered message is re-rendered without thinking");

// Even with thinking display fully ON (hideThinkingBlock=false, pi would dump the whole trace),
// nothing leaks past the shim — display stays off no matter the setting; the model still reasons.
const visibleConfig = new AssistantMessageComponent(undefined, false);
shimmedMode.chatContainer.addChild(visibleConfig);
visibleConfig.updateContent(mkAssistant([THINKING, ANSWER]));
assert.ok(!visibleConfig.render(80).join("\n").includes("secret reasoning"), "no reasoning text reaches the scrollback");

const providerFailure = new AssistantMessageComponent({
  role: "assistant", content: [], stopReason: "error", errorMessage: "credential and endpoint detail",
}, true, undefined, "");
shimmedMode.chatContainer.addChild(providerFailure);
assert.deepEqual(providerFailure.render(80), [], "technical provider failures render no raw diagnostic by default");

for (const stopReason of ["aborted", "length"] as const) {
  const partial = new AssistantMessageComponent({
    role: "assistant", content: [ANSWER], stopReason, errorMessage: "routine retry detail",
  }, true, undefined, "");
  shimmedMode.chatContainer.addChild(partial);
  assert.deepEqual(partial.render(80), baseline, `${stopReason} turns retain partial output without technical prose`);
}
assert.equal(shimmedChildren.length, 6, "assistant components still pass through to the chat");

// 9. Silent start: no initialMessage is fired by default.
assert.equal(ooInteractiveOptions().initialMessage, undefined, "no auto model turn on launch");

// 10. Delegated-run row: a compact agent line, not a generic tool call. Activity, retry,
// result, and error bodies stay out of the compact row.
assert.equal(elapsedLabel("2026-07-17T10:00:00.000Z", "2026-07-17T10:02:03.000Z"), "2m 3s");
assert.equal(elapsedLabel("2026-07-17T10:00:00.000Z", "2026-07-17T10:00:09.000Z"), "9s");
assert.equal(elapsedLabel(undefined, "2026-07-17T10:00:09.000Z"), "", "elapsed needs both stamps");
assert.equal(
  formatAgentRunRow({
    harness: "claude-code",
    task: "research the flaky retry logic in the scheduler",
    status: AgentRunStatus.Running,
    createdAt: "2026-07-17T10:00:00.000Z",
  }, "2026-07-17T10:00:30.000Z"),
  "claude-code · research the flaky retry logic in the scheduler · running · 30s",
);
assert.equal(
  formatAgentRunRow({
    harness: "codex", task: "audit deps", status: AgentRunStatus.Completed,
    createdAt: "2026-07-17T10:00:00.000Z", finishedAt: "2026-07-17T10:01:00.000Z",
  }),
  "codex · audit deps · completed · 1m",
  "a terminal row omits result and stale activity bodies",
);
assert.equal(
  formatAgentRunRow({
    harness: "codex",
    task: "x",
    status: AgentRunStatus.Failed,
  }),
  "codex · x · failed",
  "a failed row omits error and partial-result bodies",
);

process.stdout.write("ok — oo presentation: identity/theme, separate raw-detail gate, hidden reasoning, silent start\n");
