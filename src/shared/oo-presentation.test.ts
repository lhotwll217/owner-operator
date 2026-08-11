import assert from "node:assert/strict";
import { AgentRunHarness, AgentRunStatus } from "@owner-operator/core";
import {
  OO_NAME,
  buildOoTheme,
  elapsedLabel,
  formatAgentRunRow,
  ooInteractiveOptions,
  ooMarker,
  ooPalette,
} from "./oo-presentation";

const marker = ooMarker("1.2.3");
assert.equal(marker, "Owner Operator v1.2.3");
assert.doesNotMatch(marker, /\bpi\b|π/i, "the marker carries only Owner Operator identity");
assert.doesNotMatch(OO_NAME, /\bpi\b|π/i);

assert.equal(ooPalette.accent, "#b98a4b");
const theme = buildOoTheme();
assert.equal(theme.name, "owner-operator");
for (const mode of ["truecolor", "256color"] as const) {
  const toolTheme = buildOoTheme(mode);
  assert.equal(
    toolTheme.bg("toolPendingBg", "tool"),
    toolTheme.bg("toolSuccessBg", "tool"),
    `${mode} tool rows stay neutral when they settle`,
  );
}
for (const color of ["accent", "muted", "dim", "text", "toolTitle", "success", "error"] as const) {
  assert.doesNotThrow(() => theme.fg(color, "x"), `theme has the ${color} token`);
}

assert.equal(ooInteractiveOptions().initialMessage, undefined, "interactive mode starts without an automatic model turn");
assert.equal(elapsedLabel("2026-07-17T10:00:00.000Z", "2026-07-17T10:02:03.000Z"), "2m 3s");
assert.equal(elapsedLabel(undefined, "2026-07-17T10:00:09.000Z"), "");
assert.equal(
  formatAgentRunRow({
    harness: AgentRunHarness.ClaudeCode,
    model: "sonnet",
    task: "research the flaky retry logic in the scheduler",
    status: AgentRunStatus.Running,
    createdAt: "2026-07-17T10:00:00.000Z",
  }, "2026-07-17T10:00:30.000Z"),
  "Claude Code · sonnet · research the flaky retry logic in the scheduler · running · 30s",
  "the genuine delegated-run row remains compact",
);
assert.equal(
  formatAgentRunRow({
    harness: AgentRunHarness.Codex,
    task: "audit deps",
    status: AgentRunStatus.Failed,
  }),
  "Codex · audit deps · failed",
  "delegated-run rows omit error and activity bodies",
);

process.stdout.write("ok — OO presentation: identity, theme, silent start, and delegated-run rows\n");
