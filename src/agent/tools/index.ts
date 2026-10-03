import { AgentToolId, DEFAULT_TOOL_POSTURE, loadHarnessSettings } from "@owner-operator/core";
import { createGetHarnessDetailsTool, type GetHarnessDetailsToolOptions } from "./get-harness-details";
import {
  createManageDelegatedBaselineTool,
  type ManageDelegatedBaselineOptions,
} from "./manage-delegated-baseline";
import { createUseWorktreeTool } from "./use-worktree";

export { getHarnessDetailsTool } from "./get-harness-details";
export { manageDelegatedBaselineTool } from "./manage-delegated-baseline";
export { useWorktreeTool } from "./use-worktree";

export interface OwnerOperatorHarnessAdapters {
  readHarnessDetails?: GetHarnessDetailsToolOptions["read"];
  proposeDelegatedBaseline?: ManageDelegatedBaselineOptions["propose"];
}

export interface OwnerOperatorRuntimeAdapters {
  onWorktreeSelection?: (threadId: string) => void;
}

/** Production tools with only their external harness observations replaceable for deterministic
 * evaluation. Durable approval, delegation, Gateway, and state behavior remain production-real. */
export function createOwnerOperatorCustomTools(
  adapters: OwnerOperatorHarnessAdapters = {},
  runtimeAdapters: OwnerOperatorRuntimeAdapters = {},
) {
  return [
    createGetHarnessDetailsTool({ read: adapters.readHarnessDetails }),
    createManageDelegatedBaselineTool({ propose: adapters.proposeDelegatedBaseline }),
    createUseWorktreeTool({ onSelection: runtimeAdapters.onWorktreeSelection }),
  ];
}

export const ownerOperatorCustomTools = createOwnerOperatorCustomTools();

const ownerOperatorTypedTools: readonly AgentToolId[] = [
  AgentToolId.GetHarnessDetails,
  AgentToolId.ManageDelegatedBaseline,
  AgentToolId.UseWorktree,
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
