import { AgentToolId, DEFAULT_TOOL_POSTURE, loadHarnessSettings } from "@owner-operator/core";
import { withOoRenderers } from "../../shared/oo-presentation";
import { queryDatabaseTool } from "./query-database";
import { schedulePromptTool } from "./schedule-prompt";
import { getCurrentSessionStateTool, markThreadDoneTool } from "./session-state";

export { queryDatabaseTool } from "./query-database";
export { schedulePromptTool } from "./schedule-prompt";
export { getCurrentSessionStateTool, markThreadDoneTool } from "./session-state";

export const ownerOperatorCustomTools = [
  withOoRenderers(getCurrentSessionStateTool, "session state"),
  withOoRenderers(markThreadDoneTool, "mark done", {
    summarizeCall: (args) =>
      [...(args.ids ?? []), ...(args.indexes ?? []), ...(args.queries ?? [])].slice(0, 3).join(", "),
  }),
  withOoRenderers(queryDatabaseTool, "database", { summarizeCall: (args) => args.action ?? "" }),
  withOoRenderers(schedulePromptTool, "schedule", { summarizeCall: (args) => args.name ?? "" }),
];

const ownerOperatorTypedTools: readonly AgentToolId[] = [
  AgentToolId.GetCurrentSessionState,
  AgentToolId.MarkThreadDone,
  AgentToolId.QueryDatabase,
  AgentToolId.SchedulePrompt,
];

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
