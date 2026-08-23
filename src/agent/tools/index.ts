import { AgentToolId, DEFAULT_TOOL_POSTURE, loadHarnessSettings } from "@owner-operator/core";
import { delegateAgentTool } from "./delegate-agent";
import { createGetHarnessDetailsTool, type GetHarnessDetailsToolOptions } from "./get-harness-details";
import { manageAgentRunTool } from "./manage-agent-run";
import {
  createManageDelegatedBaselineTool,
  type ManageDelegatedBaselineOptions,
} from "./manage-delegated-baseline";
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
export { manageDelegatedBaselineTool } from "./manage-delegated-baseline";
export { getCurrentSessionStateTool, markThreadDoneTool } from "./session-state";

export interface OwnerOperatorHarnessAdapters {
  readHarnessDetails?: GetHarnessDetailsToolOptions["read"];
  proposeDelegatedBaseline?: ManageDelegatedBaselineOptions["propose"];
}

/** Production tools with only their external harness observations replaceable for deterministic
 * evaluation. Durable approval, delegation, Gateway, and state behavior remain production-real. */
export function createOwnerOperatorCustomTools(adapters: OwnerOperatorHarnessAdapters = {}) {
  return [
    getCurrentSessionStateTool,
    markThreadDoneTool,
    queryDatabaseTool,
    schedulePromptTool,
    manageScheduleTool,
    delegateAgentTool,
    manageAgentRunTool,
    createGetHarnessDetailsTool({ read: adapters.readHarnessDetails }),
    createManageDelegatedBaselineTool({ propose: adapters.proposeDelegatedBaseline }),
  ];
}

export const ownerOperatorCustomTools = createOwnerOperatorCustomTools();

const ownerOperatorTypedTools: readonly AgentToolId[] = [
  AgentToolId.GetCurrentSessionState,
  AgentToolId.MarkThreadDone,
  AgentToolId.QueryDatabase,
  AgentToolId.SchedulePrompt,
  AgentToolId.ManageSchedule,
  AgentToolId.DelegateAgent,
  AgentToolId.ManageAgentRun,
  AgentToolId.GetHarnessDetails,
  AgentToolId.ManageDelegatedBaseline,
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
