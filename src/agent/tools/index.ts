import { AgentToolId, DEFAULT_TOOL_POSTURE, loadHarnessSettings } from "@owner-operator/core";
import { delegateAgentTool } from "./delegate-agent";
import { getHarnessDetailsTool } from "./get-harness-details";
import { manageAgentRunTool } from "./manage-agent-run";
import { manageScheduleTool } from "./manage-schedule";
import { queryDatabaseTool } from "./query-database";
import { schedulePromptTool } from "./schedule-prompt";
import { getCurrentSessionStateTool, markThreadDoneTool } from "./session-state";

export { queryDatabaseTool } from "./query-database";
export { manageScheduleTool } from "./manage-schedule";
export { schedulePromptTool } from "./schedule-prompt";
export { delegateAgentTool } from "./delegate-agent";
export { getHarnessDetailsTool } from "./get-harness-details";
export { manageAgentRunTool } from "./manage-agent-run";
export { getCurrentSessionStateTool, markThreadDoneTool } from "./session-state";

export const ownerOperatorCustomTools = [
  getCurrentSessionStateTool,
  markThreadDoneTool,
  queryDatabaseTool,
  schedulePromptTool,
  manageScheduleTool,
  delegateAgentTool,
  manageAgentRunTool,
  getHarnessDetailsTool,
];

const ownerOperatorTypedTools: readonly AgentToolId[] = [
  AgentToolId.GetCurrentSessionState,
  AgentToolId.MarkThreadDone,
  AgentToolId.QueryDatabase,
  AgentToolId.SchedulePrompt,
  AgentToolId.ManageSchedule,
  AgentToolId.DelegateAgent,
  AgentToolId.ManageAgentRun,
  AgentToolId.GetHarnessDetails,
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
