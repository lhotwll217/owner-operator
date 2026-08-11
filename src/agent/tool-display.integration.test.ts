import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bindOwnerOperatorSessionExtensions,
  createOwnerOperatorSession,
  shutdownSessionExtensions,
} from "./agent";

const root = mkdtempSync(join(tmpdir(), "oo-tool-display-"));
const ooHome = join(root, "oo-home");
const task = join(root, "task");
const priorOoHome = process.env.OO_HOME;

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

function rendered(component: { render(width: number): string[] } | undefined, width = 80): string {
  assert.ok(component, "renderer returns a Pi component");
  return component.render(width).map((line) => line.trimEnd()).join("\n");
}

try {
  mkdirSync(join(ooHome, "pi"), { recursive: true });
  mkdirSync(task, { recursive: true });
  writeFileSync(join(ooHome, "pi", "auth.json"), "{}");
  writeFileSync(join(ooHome, "pi", "settings.json"), "{}");
  process.env.OO_HOME = ooHome;

  const { session } = await createOwnerOperatorSession("chat", { cwd: task, ephemeral: true });
  await bindOwnerOperatorSessionExtensions(session);

  const paths = session.extensionRunner.getExtensionPaths();
  const displayIndex = paths.indexOf("<inline:owner-operator-tool-display>");
  const guardIndex = paths.indexOf("<inline:owner-operator-privacy-guard>");
  assert.ok(displayIndex >= 0, "the pinned tool-display extension is loaded");
  assert.ok(guardIndex > displayIndex, "tool-display owns built-ins before the supported privacy guard loads");
  assert.equal(paths.includes("<inline:owner-operator-tools>"), false,
    "custom tools register inside the display extension instead of racing a separate extension");

  const config = JSON.parse(readFileSync(join(ooHome, "pi", "extensions", "pi-tool-display", "config.json"), "utf8"));
  assert.equal(config.enableNativeUserMessageBox, false, "Owner Operator initially keeps Pi's native user box disabled");
  assert.equal(config.readOutputMode, "summary", "the compact preset keeps raw read output expandable");
  assert.equal(config.expandedPreviewMaxLines, 0, "expanded results remain fully raw instead of truncating");
  assert.equal(config.customToolOverrides.query_database.kind, "generic");
  assert.equal(config.customToolOverrides.delegate_agent.outputMode, "preview",
    "delegation shows its authoritative compact result in the package-owned block");
  assert.deepEqual(Object.keys(config.customToolOverrides).sort(), [
    "delegate_agent",
    "get_current_session_state",
    "manage_agent_run",
    "manage_schedule",
    "mark_thread_done",
    "query_database",
    "schedule_prompt",
  ], "every OO custom tool opts into package-owned generic rendering");

  const read = session.extensionRunner.getToolDefinition("read");
  const query = session.extensionRunner.getToolDefinition("query_database");
  const delegate = session.extensionRunner.getToolDefinition("delegate_agent");
  for (const name of ["read", "grep", "find", "ls", "bash", "edit", "write"]) {
    const tool = session.extensionRunner.getToolDefinition(name);
    assert.equal(typeof tool?.renderCall, "function", `tool-display owns ${name} call rendering`);
    assert.equal(typeof tool?.renderResult, "function", `tool-display owns ${name} result rendering`);
  }
  for (const name of Object.keys(config.customToolOverrides)) {
    const tool = session.extensionRunner.getToolDefinition(name);
    assert.equal(typeof tool?.renderCall, "function", `tool-display owns ${name} call rendering`);
    assert.equal(typeof tool?.renderResult, "function", `tool-display owns ${name} result rendering`);
  }

  assert.match(rendered(read!.renderCall!({ path: "src/agent/agent.ts" }, theme as never, {} as never) as never), /^read src\/agent\/agent\.ts$/);
  assert.match(rendered(query!.renderCall!({ action: "threads", limit: 2 }, theme as never, {} as never) as never), /^query_database \(2 args\)$/);

  const result = { content: [{ type: "text", text: "first raw line\nsecond raw line" }] };
  const collapsedRead = rendered(read!.renderResult!(result as never, { expanded: false, isPartial: false } as never, theme as never, {} as never) as never);
  const expandedRead = rendered(read!.renderResult!(result as never, { expanded: true, isPartial: false } as never, theme as never, {} as never) as never);
  assert.doesNotMatch(collapsedRead, /first raw line/, "compact read results stay collapsed");
  assert.match(expandedRead, /first raw line/, "expanded read results retain raw output");

  const collapsedQuery = rendered(query!.renderResult!(result as never, { expanded: false, isPartial: false } as never, theme as never, {} as never) as never);
  const expandedQuery = rendered(query!.renderResult!(result as never, { expanded: true, isPartial: false } as never, theme as never, {} as never) as never);
  assert.doesNotMatch(collapsedQuery, /first raw line/, "generic OO results stay compact");
  assert.match(expandedQuery, /first raw line/, "expanded generic OO results retain raw output");

  const delegatedResult = {
    content: [{ type: "text", text: "Run run-123 · Codex · gpt-5.6-sol · medium · review PR #121 · pending" }],
  };
  const collapsedDelegate = rendered(
    delegate!.renderResult!(delegatedResult as never, { expanded: false, isPartial: false } as never, theme as never, {} as never) as never,
  );
  assert.match(collapsedDelegate, /Run run-123 · Codex · gpt-5\.6-sol · medium · review PR #121 · pending/,
    "delegation renders once with the resolved run identity instead of a second launch component");

  const longRawResult = {
    content: [{
      type: "text",
      text: [...Array.from({ length: 4_001 }, (_, index) => `raw line ${index + 1}`), "raw final sentinel"].join("\n"),
    }],
  };
  const expandedLongRead = rendered(
    read!.renderResult!(longRawResult as never, { expanded: true, isPartial: false } as never, theme as never, {} as never) as never,
  );
  assert.match(expandedLongRead, /raw final sentinel/, "expanded results preserve content beyond the former 4,000-line cap");

  await shutdownSessionExtensions(session);
  session.dispose();
  process.stdout.write("ok — tool display: deterministic load order plus built-in/custom compact rendering and raw expansion\n");
} finally {
  if (priorOoHome === undefined) delete process.env.OO_HOME;
  else process.env.OO_HOME = priorOoHome;
  rmSync(root, { recursive: true, force: true });
}
