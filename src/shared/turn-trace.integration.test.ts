import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { TurnActivityEvent } from "@owner-operator/core/activity";
import { buildOoTheme } from "./oo-presentation";
import { createTurnTraceExtension, OO_TURN_ACTIVITY_ENTRY } from "./turn-trace";

const root = mkdtempSync(join(tmpdir(), "oo-turn-trace-"));
try {
  const saved = SessionManager.create(root, root);
  saved.appendMessage({
    role: "user",
    content: [{ type: "text", text: "Fix the delegated runner" }],
    timestamp: 900,
  });
  const events: TurnActivityEvent[] = [
    { kind: "turn_started", turnId: "saved-turn", at: 1_000 },
    { kind: "thinking_summary", turnId: "saved-turn", eventId: "summary", at: 1_100, summary: "Inspecting saved state" },
    { kind: "tool", turnId: "saved-turn", eventId: "tool", at: 1_200, toolName: "read" },
    { kind: "turn_settled", turnId: "saved-turn", at: 4_000, outcome: "completed", hasResponse: true },
  ];
  for (const event of events) saved.appendCustomEntry(OO_TURN_ACTIVITY_ENTRY, event);
  saved.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "Final answer" }],
    api: "openai-codex-responses",
    provider: "openai-codex",
    model: "fixture",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: 4_000,
  });
  const sessionFile = saved.getSessionFile();
  assert.ok(sessionFile && readFileSync(sessionFile, "utf8").includes(OO_TURN_ACTIVITY_ENTRY), "Pi persisted normalized activity in a real saved session");

  const reopened = SessionManager.open(sessionFile, root);
  const reopenedEntries = reopened.getEntries();
  const userIndex = reopenedEntries.findIndex((entry) => entry.type === "message" && entry.message.role === "user");
  const traceIndex = reopenedEntries.findIndex((entry) => entry.type === "custom" && entry.customType === OO_TURN_ACTIVITY_ENTRY);
  const answerIndex = reopenedEntries.findIndex((entry) => entry.type === "message" && entry.message.role === "assistant");
  assert.ok(userIndex < traceIndex && traceIndex < answerIndex, "replay keeps activity below its user message and the final response last");
  const handlers = new Map<string, (event: any, ctx: any) => void>();
  let renderer: ((entry: any, options: any, theme: any) => any) | undefined;
  createTurnTraceExtension()({
    on(name: string, handler: (event: any, ctx: any) => void): void { handlers.set(name, handler); },
    registerEntryRenderer(_type: string, value: typeof renderer): void { renderer = value; },
    registerCommand(): void {},
    appendEntry(): void {},
  } as any);
  let component: { render(width: number): string[] } | undefined;
  for (const entry of reopenedEntries) {
    if ((entry as any).type !== "custom" || (entry as any).customType !== OO_TURN_ACTIVITY_ENTRY) continue;
    const rendered = renderer?.(entry, { expanded: false }, buildOoTheme());
    component ??= rendered;
  }
  assert.ok(component, "chat reconstruction restores the saved trace anchor before session_start");
  assert.equal(
    stripVTControlCharacters(component.render(80).map((line: string) => line.trimEnd()).join("\n")),
    "▶ Worked for 3s · 2 actions",
    "pre-session_start replay renders the same compact presentation as live ingestion",
  );
  handlers.get("session_start")?.({ type: "session_start", reason: "resume" }, {
    sessionManager: reopened,
    ui: { setWidget(): void {} },
  });
  assert.equal(
    stripVTControlCharacters(component.render(80).map((line: string) => line.trimEnd()).join("\n")),
    "▶ Worked for 3s · 2 actions",
    "session hydration preserves the component created during Pi's reload ordering",
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

process.stdout.write("ok — Pi saved TurnTrace: persisted entries reopen through the production renderer\n");
