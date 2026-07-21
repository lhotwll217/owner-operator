import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentSessionRuntime,
  createAgentSessionFromServices,
  createAgentSessionServices,
  InteractiveMode,
  SessionManager,
  SettingsManager,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import type { TurnActivityEvent } from "@owner-operator/core/activity";
import { renderInRealPty } from "../../test/fixtures/real-pty";
import { ooPresentationExtension, quietOoInteractiveMode } from "./oo-presentation";
import { OO_TURN_ACTIVITY_ENTRY } from "./turn-trace";

if (process.env.OO_TURN_TRACE_PTY_CHILD === "1") {
  const mode = process.argv[2] ?? "active";
  const actions = [
    "Inspecting the delegated-run launcher",
    "Comparing adapter versions",
    "Reviewing activity patterns",
    "Updating the live acceptance test",
    "Running typecheck and lint",
    "Running full verification",
  ];
  const root = mkdtempSync(join(tmpdir(), "oo-turn-trace-pty-"));
  try {
    const agentDir = join(root, "agent");
    const ooHome = join(root, "oo-home");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(ooHome, { recursive: true });
    process.env.HOME = root;
    process.env.OO_HOME = ooHome;
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
      quietStartup: true,
      hideThinkingBlock: true,
      outputPad: 0,
      defaultProjectTrust: "always",
    }));
    const sessionManager = SessionManager.inMemory(root);
    const events: TurnActivityEvent[] = [
      { kind: "turn_started", turnId: "pty-turn", at: 0 },
      ...actions.map((summary, index): TurnActivityEvent => ({
        kind: "thinking_summary",
        turnId: "pty-turn",
        eventId: `action-${index}`,
        at: 100 + index,
        summary,
      })),
      ...(mode === "active" ? [] : [{
        kind: "turn_settled" as const,
        turnId: "pty-turn",
        at: 8 * 60 * 1_000,
        outcome: "completed" as const,
      }]),
    ];
    if (mode !== "active") {
      for (const event of events) sessionManager.appendCustomEntry(OO_TURN_ACTIVITY_ENTRY, event);
    }
    sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "raw-call", name: "read", arguments: { path: "/private/credential.txt" } }],
      api: "openai-codex-responses",
      provider: "openai-codex",
      model: "fixture",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "toolUse",
      timestamp: 700,
    });
    sessionManager.appendMessage({
      role: "toolResult",
      toolCallId: "raw-call",
      toolName: "read",
      content: [{ type: "text", text: "raw credential result" }],
      isError: false,
      timestamp: 800,
    });

    const createRuntime = async ({ sessionManager: target }: { sessionManager: SessionManager }) => {
      const settingsManager = SettingsManager.create(root, agentDir, { projectTrusted: true });
      const services = await createAgentSessionServices({
        cwd: root,
        agentDir,
        settingsManager,
        resourceLoaderOptions: {
          systemPromptOverride: () => "PTY presentation fixture",
          appendSystemPromptOverride: () => [],
          extensionFactories: [{ name: "owner-operator-presentation", factory: ooPresentationExtension }],
        },
      });
      const created = await createAgentSessionFromServices({ services, sessionManager: target });
      return { ...created, services, diagnostics: services.diagnostics };
    };
    const created = await createRuntime({ sessionManager });
    const runtime = new AgentSessionRuntime(created.session, created.services, createRuntime as any, created.diagnostics);
    initTheme(created.services.settingsManager.getTheme(), true);
    const interactive = new InteractiveMode(runtime, {});
    quietOoInteractiveMode(interactive);
    await (interactive as any).init();

    if (mode === "active") {
      for (const event of events) {
        sessionManager.appendCustomEntry(OO_TURN_ACTIVITY_ENTRY, event);
        const entry = sessionManager.getEntries().at(-1);
        assert.equal(entry?.type, "custom");
        (interactive as any).addCustomEntryToChat(entry);
      }
    }

    if (mode === "expanded") {
      (interactive as any).showExtensionSelector = async (_title: string, choices: string[]) => choices[0];
      const command = created.session.extensionRunner.getCommand("activity");
      assert.ok(command, "the real Pi runtime registered /activity");
      await command.handler("", created.session.extensionRunner.createCommandContext());
    } else if (mode === "raw") {
      (interactive as any).setToolsExpanded(true);
    }

    const width = process.stdout.columns ?? 80;
    const lines = (interactive as any).chatContainer.render(width)
      .map((line: string) => line.trimEnd());
    process.stdout.write(`\nTTY=${process.stdout.isTTY === true} COLS=${width}\nBEGIN\n${lines.join("\n")}\nEND\n`);
    await (interactive as any).shutdown();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  process.exit(0);
}

async function renderInPty(width: number, mode: "active" | "settled" | "expanded" | "raw"): Promise<string[]> {
  const command = "stty cols \"$OO_TURN_TRACE_WIDTH\" rows 40; exec env -u NODE_USE_SYSTEM_CA OO_TURN_TRACE_PTY_CHILD=1 node --import tsx src/shared/turn-trace.pty.integration.test.ts \"$OO_TURN_TRACE_MODE\"";
  return renderInRealPty({
    command,
    width,
    env: { OO_TURN_TRACE_WIDTH: String(width), OO_TURN_TRACE_MODE: mode },
    label: `TurnTrace PTY fixture in ${mode} mode`,
  });
}

const normal = await renderInPty(80, "active");
assert.deepEqual(normal, [
  "",
  "│ Inspecting the delegated-run launcher",
  "│ Comparing adapter versions",
  "│ Reviewing activity patterns",
  "│ Updating the live acceptance test",
  "│ Running typecheck and lint",
  "● Running full verification",
], "normal-width PTY matches the approved Timeline rail");
assert.equal(normal.filter((line) => line === "").length, 1, "Pi inserts exactly one spacer before inline activity");

const narrow = await renderInPty(34, "active");
assert.equal(narrow[0], "", "narrow mode retains exactly one leading transcript spacer");
assert.ok(narrow.slice(1).every(Boolean), "narrow mode has no manufactured vertical gaps");
assert.ok(narrow.some((line) => line.startsWith("│ ")), "narrow mode retains the prior-action rail");
assert.ok(narrow.some((line) => line.startsWith("● ")), "narrow mode retains the non-color current marker");
for (const line of narrow) assert.ok([...line].length <= 34, `narrow line fits 34 columns: ${line}`);
let sourceOffset = -1;
const narrowText = narrow.slice(1).join(" ");
for (const action of normal.slice(1).map((line) => line.slice(2))) {
  const next = narrowText.indexOf(action, sourceOffset + 1);
  assert.ok(next > sourceOffset, `narrow Pi surface retains ordered action: ${action}`);
  sourceOffset = next;
}

assert.deepEqual(await renderInPty(80, "settled"), [
  "",
  "▶ Worked for 8m 0s · 6 actions · expand trace",
], "settlement collapses through Pi's real custom-entry host");
const expanded = await renderInPty(80, "expanded");
assert.equal(expanded[0], "", "expanded activity keeps the single transcript spacer");
assert.equal(expanded[1], "▼ Worked for 8m 0s · 6 actions · collapse trace");
assert.deepEqual(expanded.slice(2), normal.slice(1).map((line) => line.replace(/^● /, "│ ")), "expanded settlement restores the ordered semantic trace");
const raw = await renderInPty(80, "raw");
assert.ok(raw.some((line) => line.includes("/private/credential.txt") || line.includes("raw credential result")), "Pi's separate tool expansion restores raw detail explicitly");
assert.ok(!normal.some((line) => line.includes("credential")), "raw arguments and results stay hidden in the normal Pi surface");

process.stdout.write("ok — real Pi PTY TurnTrace: timeline at 80/34 columns, settlement, semantic/raw expansion\n");
