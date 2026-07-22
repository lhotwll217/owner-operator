import { AgentToolId, DEFAULT_TOOL_POSTURE, loadHarnessSettings } from "@owner-operator/core";
import { formatAgentRunRow, withOoRenderers } from "../../shared/oo-presentation";
import { toAgentRunRowView } from "./agent-run-result";
import { delegateAgentTool } from "./delegate-agent";
import { manageAgentRunTool } from "./manage-agent-run";
import { manageScheduleTool } from "./manage-schedule";
import { queryDatabaseTool } from "./query-database";
import { schedulePromptTool } from "./schedule-prompt";
import { getCurrentSessionStateTool, markThreadDoneTool } from "./session-state";

export { queryDatabaseTool } from "./query-database";
export { manageScheduleTool } from "./manage-schedule";
export { schedulePromptTool } from "./schedule-prompt";
export { delegateAgentTool } from "./delegate-agent";
export { manageAgentRunTool } from "./manage-agent-run";
export { getCurrentSessionStateTool, markThreadDoneTool } from "./session-state";

export const ownerOperatorCustomTools = [
  withOoRenderers(getCurrentSessionStateTool, "session state"),
  withOoRenderers(markThreadDoneTool, "mark done", {
    summarizeCall: (args) =>
      [...(args.ids ?? []), ...(args.indexes ?? []), ...(args.queries ?? [])].slice(0, 3).join(", "),
  }),
  withOoRenderers(queryDatabaseTool, "database", { summarizeCall: (args) => args.action ?? "" }),
  withOoRenderers(schedulePromptTool, "schedule", { summarizeCall: (args) => args.name ?? "" }),
  withOoRenderers(manageScheduleTool, "manage schedule", { summarizeCall: (args) => args.id ?? "" }),
  withOoRenderers(delegateAgentTool, "delegate", {
    summarizeCall: (args) => [args.harness, args.task].filter(Boolean).join(" · "),
    summarizeResult: (result) => formatAgentRunRow(result?.details ? toAgentRunRowView(result.details) : {}),
  }),
  withOoRenderers(manageAgentRunTool, "manage run", {
    summarizeCall: (args) => `${args.action ?? ""} ${args.id ?? ""}`.trim(),
    summarizeResult: (result) => formatAgentRunRow(result?.details ? toAgentRunRowView(result.details) : {}),
  }),
];

const ownerOperatorTypedTools: readonly AgentToolId[] = [
  AgentToolId.GetCurrentSessionState,
  AgentToolId.MarkThreadDone,
  AgentToolId.QueryDatabase,
  AgentToolId.SchedulePrompt,
  AgentToolId.ManageSchedule,
  AgentToolId.DelegateAgent,
  AgentToolId.ManageAgentRun,
];

// packages/core/src/permissions.mjs assigns explicit read/change defaults for these known tools.
// A new tool remains safe if this list grows first: Pi falls back to the selected global mode.
export const ownerOperatorTools: readonly AgentToolId[] = [
  ...DEFAULT_TOOL_POSTURE as AgentToolId[],
  ...ownerOperatorTypedTools,
];

export function configuredOwnerOperatorTools(ooHome?: string): readonly AgentToolId[] {
  return [
    ...loadHarnessSettings(ooHome).toolPosture as AgentToolId[],
    ...ownerOperatorTypedTools,
  ];
}
