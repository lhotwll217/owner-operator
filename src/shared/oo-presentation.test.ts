// Unit: the OO presentation seam. We test external behaviour — the rendered strings, the
// palette data, the single-working-line fold, the zero-dump shim — not pi's live TUI (which
// needs a real TTY and isn't snapshot-testable in this hermetic runner). The shim tests render
// pi's REAL AssistantMessageComponent, so a pi rename/reshape fails here loudly instead of
// silently letting the dump back into the scrollback. Same assertion style as
// src/cli/oo-args.test.ts.
import assert from "node:assert";
import { initTheme } from "@earendil-works/pi-coding-agent";
import {
  OO_CYCLE_WORDS,
  OO_NAME,
  OO_TOOL_LINGER_TICKS,
  OoWorkingLine,
  buildOoTheme,
  elapsedLabel,
  foldWorkingLine,
  formatAgentRunRow,
  isAssistantMessageRow,
  isToolExecutionRow,
  ooInteractiveOptions,
  ooMarker,
  ooPalette,
  quietOoInteractiveMode,
  statusLabelFor,
  type OoWorkEvent,
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

// 3. The cycling words: a persona-rich set — confident chief-of-staff, short, quiet, unique.
assert.ok(OO_CYCLE_WORDS.length >= 8, "a persona-rich set of at least 8 cycle words");
assert.equal(new Set(OO_CYCLE_WORDS).size, OO_CYCLE_WORDS.length, "no duplicate cycle words");
assert.equal(OO_CYCLE_WORDS[0], "working…", "leads with plain work");
assert.ok(([...OO_CYCLE_WORDS] as string[]).includes("owning and operating…"), "the namesake word is in the cycle");
for (const word of OO_CYCLE_WORDS) {
  assert.ok(word.endsWith("…"), `"${word}" keeps the … suffix`);
  assert.equal(word, word.toLowerCase(), `"${word}" stays lowercase — a status line, not a headline`);
  assert.ok(!word.includes("\n") && word.length <= 24, `"${word}" is short and single-line`);
}

// 4. The single working line collapses a sequence of N stream/tool events to ONE current line —
//    it replaces, never accumulates.
// A running tool overrides the cycling word with the tool's label…
assert.equal(
  foldWorkingLine([{ kind: "resume" }, { kind: "tool_start", toolName: "bash" }]),
  statusLabelFor("bash"),
  "a running tool names itself on the one line",
);
// …and the label is a single line, not a wall.
const toolLine = foldWorkingLine([{ kind: "tool_start", toolName: "query_database" }]);
assert.ok(toolLine && !toolLine.includes("\n"), "the working line is a single line, never a wall");
// Two tools in a row: only the latest shows — nothing lingers past a replacement.
assert.equal(
  foldWorkingLine([
    { kind: "tool_start", toolName: "bash" },
    { kind: "tool_end" },
    { kind: "tool_start", toolName: "query_database" },
  ]),
  statusLabelFor("query_database"),
  "only the latest tool shows; the previous does not linger",
);

// resume begins on the first cycling word; idle clears the line entirely.
assert.equal(foldWorkingLine([{ kind: "resume" }]), OO_CYCLE_WORDS[0], "resume → first cycle word");
assert.equal(
  foldWorkingLine([{ kind: "tool_start", toolName: "bash" }, { kind: "idle" }]),
  undefined,
  "idle clears the working line",
);
// After the answer starts streaming (idle), the next turn's resume picks the cycle back up
// where it left off — livelier than restarting on the same word every turn.
assert.equal(
  foldWorkingLine([{ kind: "resume" }, { kind: "tick" }, { kind: "idle" }, { kind: "resume" }]),
  OO_CYCLE_WORDS[1],
  "resume revives the cycle from idle, keeping its place",
);

// 5. The cycling words advance one per tick and wrap. Between tools the word keeps moving;
//    it never accumulates.
const cyclingTicks: OoWorkEvent[] = [{ kind: "resume" }, { kind: "tick" }, { kind: "tick" }];
assert.equal(foldWorkingLine(cyclingTicks), OO_CYCLE_WORDS[2], "two ticks advance to the third word");
const fullLap: OoWorkEvent[] = [{ kind: "resume" }, ...Array<OoWorkEvent>(OO_CYCLE_WORDS.length).fill({ kind: "tick" })];
assert.equal(foldWorkingLine(fullLap), OO_CYCLE_WORDS[0], "a full lap of ticks wraps back to the first word");
// A tick while a tool runs does NOT advance the word — the tool label owns the line.
assert.equal(
  foldWorkingLine([{ kind: "resume" }, { kind: "tool_start", toolName: "read" }, { kind: "tick" }]),
  statusLabelFor("read"),
  "ticks don't disturb a running tool's label",
);
// The visibility fix: a finished tool's label lingers OO_TOOL_LINGER_TICKS beats past tool_end,
// so even a millisecond-fast tool (get_current_session_state returns almost instantly) is
// legible in the cycle rather than flashing by unseen — then cycling resumes where it paused.
const linger = new OoWorkingLine();
linger.apply({ kind: "resume" }); // working… (idx 0)
linger.apply({ kind: "tick" }); // idx 1
linger.apply({ kind: "tool_start", toolName: "read" }); // → tool label
linger.apply({ kind: "tool_end" }); // label lingers, does not snap back
assert.equal(linger.current, statusLabelFor("read"), "the label holds through tool_end");
assert.equal(linger.apply({ kind: "resume" }), statusLabelFor("read"), "a turn boundary doesn't cut the linger short");
for (let beat = 1; beat < OO_TOOL_LINGER_TICKS; beat++) {
  assert.equal(linger.apply({ kind: "tick" }), statusLabelFor("read"), `the label lingers through beat ${beat}`);
}
assert.equal(linger.apply({ kind: "tick" }), OO_CYCLE_WORDS[2], "after the linger, cycling resumes where it paused");

// The live reducer returns the current line as each event is applied, and starts empty.
const line = new OoWorkingLine();
assert.equal(line.current, undefined, "starts empty");
assert.equal(line.apply({ kind: "tool_start", toolName: "mark_thread_done" }), statusLabelFor("mark_thread_done"));
assert.equal(line.apply({ kind: "tool_start", toolName: "read" }), statusLabelFor("read"), "each start replaces the line");
assert.equal(line.apply({ kind: "idle" }), undefined, "idle clears it");

// Labels are human, compact, and single-line.
for (const name of ["bash", "query_database", "read", "mark_thread_done", "unknown_tool"]) {
  const label = statusLabelFor(name);
  assert.ok(label.length > 0 && !label.includes("\n"), `${name} → a compact one-line label`);
}

// 6. The zero-dump predicates match pi's components by class name — the guard that keeps the
//    wall of tool output and the reasoning dump out of scrollback. If pi renames a component,
//    this file (and the real-component render test below) is where it fails loudly.
assert.ok(isToolExecutionRow({ constructor: { name: "ToolExecutionComponent" } }), "matches the pi tool row");
assert.ok(!isToolExecutionRow({ constructor: { name: "AssistantMessageComponent" } }), "leaves assistant messages alone");
assert.ok(!isToolExecutionRow(null), "null is not a tool row");
assert.ok(!isToolExecutionRow(undefined), "undefined is not a tool row");
assert.ok(isAssistantMessageRow({ constructor: { name: "AssistantMessageComponent" } }), "matches the pi assistant row");
assert.ok(!isAssistantMessageRow({ constructor: { name: "ToolExecutionComponent" } }), "tool rows are not assistant rows");
assert.ok(!isAssistantMessageRow(null), "null is not an assistant row");

// 7. quietOoInteractiveMode wires the interception in place: tool rows are dropped from the
//    chat, everything else passes through, and the startup update notices are silenced. A fake
//    mode stands in for pi's InteractiveMode (structural, no pi import) — mirrors how pi calls
//    `chatContainer.addChild(component)` and `showPackageUpdateNotification(...)`.
const children: unknown[] = [];
let pkgNoticeShown = false;
let verNoticeShown = false;
const fakeMode = {
  chatContainer: { children, addChild: (c: unknown) => void children.push(c) },
  showPackageUpdateNotification: () => { pkgNoticeShown = true; },
  showNewVersionNotification: () => { verNoticeShown = true; },
};
quietOoInteractiveMode(fakeMode);
fakeMode.chatContainer.addChild({ constructor: { name: "ToolExecutionComponent" } });
fakeMode.chatContainer.addChild({ constructor: { name: "AssistantMessageComponent" } });
fakeMode.chatContainer.addChild({ constructor: { name: "Text" } });
assert.equal(children.length, 2, "the tool row is dropped; assistant + text rows pass through");
assert.ok(children.every((c) => !isToolExecutionRow(c)), "no tool row reaches the scrollback");
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
assert.equal(shimmedChildren.length, 3, "assistant components still pass through to the chat");

// 9. Silent start: no initialMessage is fired by default.
assert.equal(ooInteractiveOptions().initialMessage, undefined, "no auto model turn on launch");

// 10. Delegated-run row: a compact agent line, not a generic tool call. Running rows show the
// latest activity; terminal rows show the outcome (error preferred over result); elapsed derives
// from created→finished (or created→now while live).
assert.equal(elapsedLabel("2026-07-17T10:00:00.000Z", "2026-07-17T10:02:03.000Z"), "2m 3s");
assert.equal(elapsedLabel("2026-07-17T10:00:00.000Z", "2026-07-17T10:00:09.000Z"), "9s");
assert.equal(elapsedLabel(undefined, "2026-07-17T10:00:09.000Z"), "", "elapsed needs both stamps");
assert.equal(
  formatAgentRunRow({
    harness: "claude-code",
    task: "research the flaky retry logic in the scheduler",
    status: "running",
    activity: "reading src/scheduler",
    createdAt: "2026-07-17T10:00:00.000Z",
  }, "2026-07-17T10:00:30.000Z"),
  "claude-code · research the flaky retry logic in the scheduler · running · reading src/scheduler · 30s",
);
assert.equal(
  formatAgentRunRow({
    harness: "codex", task: "audit deps", status: "completed",
    activity: "still going", resultTail: "no vulnerable deps found",
    createdAt: "2026-07-17T10:00:00.000Z", finishedAt: "2026-07-17T10:01:00.000Z",
  }),
  "codex · audit deps · completed · no vulnerable deps found · 1m 0s",
  "a terminal row shows the outcome, not the stale activity",
);
assert.equal(
  formatAgentRunRow({ harness: "codex", task: "x", status: "failed", error: "turn failed: tool error", resultTail: "partial" }),
  "codex · x · failed · turn failed: tool error",
  "a failed row prefers the error over partial output",
);

process.stdout.write("ok — oo presentation: de-branded marker, OO palette, single working line, cycle words + tool linger, zero-dump shim (tool rows + thinking), silent start\n");
