import { AgentRunHarness } from "@owner-operator/core";

export interface AgentRunLaunchConfig {
  defaultModel: string;
}

/** Runtime-owned defaults for delegated work. Keep these explicit so a harness's ambient
 * configuration cannot silently select an unsuitable extended-context model. */
export const AGENT_RUN_LAUNCH_CONFIG: Readonly<Record<AgentRunHarness, AgentRunLaunchConfig>> = {
  [AgentRunHarness.ClaudeCode]: { defaultModel: "sonnet" },
  [AgentRunHarness.Codex]: { defaultModel: "gpt-5.6-sol" },
};

export function resolveAgentRunModel(harness: AgentRunHarness, pinnedModel?: string | null): string {
  return pinnedModel ?? AGENT_RUN_LAUNCH_CONFIG[harness].defaultModel;
}
