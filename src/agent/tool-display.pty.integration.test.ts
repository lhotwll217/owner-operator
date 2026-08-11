import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentSessionRuntime,
  createAgentSessionFromServices,
  createAgentSessionServices,
  initTheme,
  InteractiveMode,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { getCapabilities } from "@earendil-works/pi-tui";
import { renderInRealPty } from "../../test/fixtures/real-pty";
import { buildOoTheme, ooPresentationExtension } from "../shared/oo-presentation";
import { queryDatabaseTool } from "./tools";
import { createOwnerOperatorToolDisplayExtension } from "./tool-display";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

if (process.env.OO_TOOL_DISPLAY_PTY_CHILD === "1") {
  const root = mkdtempSync(join(tmpdir(), "oo-tool-display-pty-"));
  try {
    const agentDir = join(root, "agent");
    mkdirSync(agentDir, { recursive: true });
    process.env.HOME = root;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
      quietStartup: true,
      outputPad: 0,
      defaultProjectTrust: "always",
    }));
    const display = await createOwnerOperatorToolDisplayExtension(agentDir, [queryDatabaseTool]);

    const sessionManager = SessionManager.inMemory(root);
    sessionManager.appendMessage({
      role: "assistant",
      content: [
        { type: "toolCall", id: "read-call", name: "read", arguments: { path: "src/agent/agent.ts" } },
        { type: "toolCall", id: "query-call", name: "query_database", arguments: { action: "threads", limit: 2 } },
      ],
      api: "openai-codex-responses",
      provider: "openai-codex",
      model: "fixture",
      usage,
      stopReason: "toolUse",
      timestamp: 100,
    });
    sessionManager.appendMessage({
      role: "toolResult",
      toolCallId: "read-call",
      toolName: "read",
      content: [{ type: "text", text: "READ RAW RESULT" }],
      isError: false,
      timestamp: 200,
    });
    sessionManager.appendMessage({
      role: "toolResult",
      toolCallId: "query-call",
      toolName: "query_database",
      content: [{ type: "text", text: "QUERY RAW RESULT" }],
      isError: false,
      timestamp: 300,
    });

    const createRuntime = async ({ sessionManager: target }: { sessionManager: SessionManager }) => {
      const settingsManager = SettingsManager.create(root, agentDir, { projectTrusted: true });
      const services = await createAgentSessionServices({
        cwd: root,
        agentDir,
        settingsManager,
        resourceLoaderOptions: {
          systemPromptOverride: () => "tool display PTY fixture",
          appendSystemPromptOverride: () => [],
          extensionFactories: [
            { name: "owner-operator-tool-display", factory: display },
            { name: "owner-operator-presentation", factory: ooPresentationExtension },
          ],
        },
      });
      const created = await createAgentSessionFromServices({
        services,
        sessionManager: target,
        tools: ["read", "query_database"],
      });
      return { ...created, services, diagnostics: services.diagnostics };
    };

    const created = await createRuntime({ sessionManager });
    const runtime = new AgentSessionRuntime(created.session, created.services, createRuntime as never, created.diagnostics);
    initTheme(created.services.settingsManager.getTheme(), true);
    const interactive = new InteractiveMode(runtime, {});
    await (interactive as any).init();
    if (process.env.OO_TOOL_DISPLAY_EXPANDED === "1") {
      (interactive as any).toggleToolOutputExpansion();
    }
    const width = process.stdout.columns ?? Number(process.env.OO_TOOL_DISPLAY_WIDTH ?? 80);
    const lines = (interactive as any).chatContainer.render(width).map((line: string) => line.trimEnd());
    const rendered = lines.join("\n");
    const mode = getCapabilities().trueColor ? "truecolor" : "256color";
    const neutralPrefix = buildOoTheme(mode).bg("toolSuccessBg", "X").replace("X", "").replace("\u001b[49m", "");
    assert.match(rendered, new RegExp(neutralPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      "completed tool rows use Owner Operator's neutral success background");
    process.stdout.write(`\nTTY=${process.stdout.isTTY === true} COLS=${width}\nBEGIN\n${rendered}\nEND\n`);
    interactive.stop();
    await runtime.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  process.exit(0);
}

async function render(width: number, expanded = false): Promise<string[]> {
  const command = "stty cols \"$OO_TOOL_DISPLAY_WIDTH\" rows 40; exec env -u NODE_USE_SYSTEM_CA OO_TOOL_DISPLAY_PTY_CHILD=1 node --import tsx src/agent/tool-display.pty.integration.test.ts";
  return renderInRealPty({
    command,
    width,
    env: {
      OO_TOOL_DISPLAY_WIDTH: String(width),
      ...(expanded ? { OO_TOOL_DISPLAY_EXPANDED: "1" } : {}),
    },
    label: `tool display PTY fixture at ${width} columns`,
  });
}

const normal = await render(80);
const normalText = normal.join("\n");
assert.match(normalText, /read src\/agent\/agent\.ts/);
assert.match(normalText, /query_database \(2 args\)/);
assert.doesNotMatch(normalText, /READ RAW RESULT|QUERY RAW RESULT/, "compact PTY hides raw results");

const narrow = await render(34);
assert.match(narrow.join("\n"), /read src\/agent\/agent\.ts/);
assert.match(narrow.join("\n"), /query_database \(2 args\)/);
for (const line of narrow) assert.ok([...line].length <= 34, `narrow tool row fits 34 columns: ${line}`);

const expanded = (await render(80, true)).join("\n");
assert.match(expanded, /READ RAW RESULT/);
assert.match(expanded, /QUERY RAW RESULT/);

process.stdout.write("ok — real Pi PTY tool display: built-in/custom compact rows at 80/34 columns and raw expansion\n");
