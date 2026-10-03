import { AgentToolId, DEFAULT_TOOL_POSTURE, loadHarnessSettings } from "@owner-operator/core";
import { createUseWorktreeTool } from "./use-worktree";

export { useWorktreeTool } from "./use-worktree";

export interface OwnerOperatorRuntimeAdapters {
  onWorktreeSelection?: (threadId: string) => void;
}

export function createOwnerOperatorCustomTools(runtimeAdapters: OwnerOperatorRuntimeAdapters = {}) {
  return [
    createUseWorktreeTool({ onSelection: runtimeAdapters.onWorktreeSelection }),
  ];
}

export const ownerOperatorCustomTools = createOwnerOperatorCustomTools();

const ownerOperatorTypedTools: readonly AgentToolId[] = [
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
