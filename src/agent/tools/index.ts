import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { AgentToolId, DEFAULT_TOOL_POSTURE, loadHarnessSettings } from "@owner-operator/core";

/** Native Operator tools. Every capability is an `oo` verb the Operator runs from bash; a native
 * tool belongs here only when a UI renders its result (adr/0001-agent-uses-its-own-cli.md). */
export const ownerOperatorCustomTools: ToolDefinition[] = [];

export const ownerOperatorTools: readonly AgentToolId[] = [...DEFAULT_TOOL_POSTURE as AgentToolId[]];

export function configuredOwnerOperatorTools(ooHome?: string): readonly AgentToolId[] {
  return [...loadHarnessSettings(ooHome).toolPosture as AgentToolId[]];
}
