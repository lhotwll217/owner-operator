// Unit: the OO presentation seam. We test external behaviour — the rendered strings, the
// palette data, the status-line fold, the silent-start options — not pi's live TUI (which
// needs a real TTY and isn't snapshot-testable in this hermetic runner). Same assertion
// style as src/cli/oo-args.test.ts.
import assert from "node:assert";
import {
  OO_NAME,
  OoStatusLine,
  buildOoTheme,
  foldStatusLine,
  ooInteractiveOptions,
  ooMarker,
  ooPalette,
  ooStartHint,
  statusLabelFor,
  type OoTurnEvent,
} from "./oo-presentation";

// 1. The identity marker reads as Owner Operator and carries NO pi branding.
const marker = ooMarker("1.2.3");
assert.equal(marker, "Owner Operator v1.2.3", "marker is the OO name + version");
assert.doesNotMatch(marker, /\bpi\b/i, "marker has no 'pi' branding");
assert.doesNotMatch(marker, /π/, "marker has no pi glyph");
assert.doesNotMatch(OO_NAME, /\bpi\b/i, "the surface name has no 'pi' branding");
assert.doesNotMatch(ooStartHint(), /\bpi\b/i, "the start hint has no 'pi' branding");
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

// 3. The status-line formatter collapses a sequence of N tool/turn events to a SINGLE current
//    line — it replaces, never accumulates.
const sequence: OoTurnEvent[] = [
  { kind: "turn_start" },
  { kind: "tool_start", toolName: "search_sessions" },
  { kind: "tool_end", toolName: "search_sessions" },
  { kind: "tool_start", toolName: "query_database" },
  { kind: "tool_end", toolName: "query_database" },
];
const line = foldStatusLine(sequence);
assert.equal(line, statusLabelFor("query_database"), "current line = the latest activity only");
assert.ok(line && !line.includes("\n"), "the status line is a single line, never a wall");
assert.ok(!line!.includes(statusLabelFor("search_sessions")), "earlier activity does not linger/accumulate");

// turn_start alone shows a generic working label; idle clears the line entirely.
assert.equal(foldStatusLine([{ kind: "turn_start" }]), "thinking…", "turn_start → working label");
assert.equal(
  foldStatusLine([{ kind: "tool_start", toolName: "search_sessions" }, { kind: "idle" }]),
  undefined,
  "idle clears the status line",
);

// The live reducer returns the current line as each event is applied.
const status = new OoStatusLine();
assert.equal(status.current, undefined, "starts empty");
assert.equal(status.apply({ kind: "tool_start", toolName: "mark_thread_done" }), statusLabelFor("mark_thread_done"));
assert.equal(status.apply({ kind: "tool_start", toolName: "read" }), statusLabelFor("read"), "each start replaces the line");
assert.equal(status.apply({ kind: "idle" }), undefined, "idle clears it");

// Labels are human, compact, and single-line.
for (const name of ["search_sessions", "query_database", "read", "mark_thread_done", "unknown_tool"]) {
  const label = statusLabelFor(name);
  assert.ok(label.length > 0 && !label.includes("\n"), `${name} → a compact one-line label`);
}

// 4. Silent start: no initialMessage is fired by default.
assert.equal(ooInteractiveOptions().initialMessage, undefined, "no auto model turn on launch");

process.stdout.write("ok — oo presentation: de-branded marker, OO palette, single-line status fold, silent start\n");
