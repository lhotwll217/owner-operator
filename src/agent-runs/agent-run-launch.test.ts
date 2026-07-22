import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { AgentRunHarness, AgentRunStatus } from "@owner-operator/core";
import { agentRunFixture as run } from "../../test/fixtures/agent-run";
import { buildOoTheme } from "../shared/oo-presentation";
import {
  AGENT_RUN_LAUNCH_ENTRY_TYPE,
  agentRunLaunchExtension,
  formatAgentRunLaunch,
} from "./agent-run-launch";

const handlers = new Map<string, Function>();
let renderer: Function | undefined;
const appended: Array<{ type: string; data: unknown }> = [];
agentRunLaunchExtension({
  on(name: string, handler: Function) { handlers.set(name, handler); },
  registerEntryRenderer(type: string, value: Function) {
    assert.equal(type, AGENT_RUN_LAUNCH_ENTRY_TYPE);
    renderer = value;
  },
  appendEntry(type: string, data: unknown) { appended.push({ type, data }); },
} as any);

const launched = run("launch-1", AgentRunStatus.Pending, {
  harness: AgentRunHarness.Codex,
  model: "gpt-5.6-sol",
  effort: "high",
  task: "Fix the delegated runner",
});
handlers.get("tool_execution_end")?.({
  toolName: "delegate_agent",
  isError: false,
  result: { details: launched },
});
assert.equal(appended.length, 1, "a successful delegation persists one own-component entry");
assert.equal(
  formatAgentRunLaunch(appended[0]!.data as any),
  "Delegated to Codex · gpt-5.6-sol · high — Fix the delegated runner",
);
const component = renderer?.(
  { data: appended[0]!.data },
  { expanded: false },
  buildOoTheme("256color"),
);
assert.equal(
  stripVTControlCharacters(component.render(100).map((line: string) => line.trimEnd()).join("\n")),
  "Delegated to Codex · gpt-5.6-sol · high — Fix the delegated runner",
  "the own component renders a neutral ledger-derived launch line",
);

handlers.get("tool_execution_end")?.({ toolName: "delegate_agent", isError: true, result: { details: launched } });
handlers.get("tool_execution_end")?.({ toolName: "manage_agent_run", isError: false, result: { details: launched } });
assert.equal(appended.length, 1, "failed delegation and management calls never create launch moments");

process.stdout.write("ok — delegated-run launch is one durable ledger-derived component\n");
