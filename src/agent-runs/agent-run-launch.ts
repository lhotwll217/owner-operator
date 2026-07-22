import {
  AgentRunHarness,
  isAgentRunEffort,
  type AgentRun,
} from "@owner-operator/core";
import {
  AGENT_STATE_TASK_MAX_LENGTH,
  bounded,
  formatAgentRunIdentity,
} from "@owner-operator/core/agent-state";
import type { ExtensionFactory, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

export const AGENT_RUN_LAUNCH_ENTRY_TYPE = "owner-operator.agent-run-launch.v1";

export interface AgentRunLaunchEntry {
  version: 1;
  runId: string;
  harness: AgentRun["harness"];
  model: string | null;
  effort: AgentRun["effort"];
  task: string;
}

function launchEntry(value: unknown): AgentRunLaunchEntry | undefined {
  if (!value || typeof value !== "object") return undefined;
  const run = value as Partial<AgentRun>;
  if (typeof run.id !== "string" || !Object.values(AgentRunHarness).includes(run.harness as AgentRunHarness)) {
    return undefined;
  }
  if (typeof run.task !== "string" || (run.model !== null && typeof run.model !== "string")) return undefined;
  if (run.effort !== null && !isAgentRunEffort(run.effort)) return undefined;
  return {
    version: 1,
    runId: run.id,
    harness: run.harness as AgentRun["harness"],
    model: run.model,
    effort: run.effort,
    task: bounded(run.task, AGENT_STATE_TASK_MAX_LENGTH),
  };
}

function parseLaunchEntry(value: unknown): AgentRunLaunchEntry | undefined {
  if (!value || typeof value !== "object") return undefined;
  const entry = value as Partial<AgentRunLaunchEntry>;
  if (entry.version !== 1) return undefined;
  return launchEntry({
    id: entry.runId,
    harness: entry.harness,
    model: entry.model,
    effort: entry.effort,
    task: entry.task,
  });
}

export function formatAgentRunLaunch(entry: AgentRunLaunchEntry): string {
  return `Delegated to ${formatAgentRunIdentity(entry.harness, entry.model, entry.effort)} — ${entry.task}`;
}

export function renderAgentRunLaunch(entry: AgentRunLaunchEntry, theme: Theme): Text {
  return new Text(theme.fg("dim", formatAgentRunLaunch(entry)), 0, 0);
}

/** Persist one ledger-derived launch moment after a successful delegate_agent tool result. */
export const agentRunLaunchExtension: ExtensionFactory = (pi) => {
  pi.registerEntryRenderer<AgentRunLaunchEntry>(AGENT_RUN_LAUNCH_ENTRY_TYPE, (entry, _options, theme) => {
    const parsed = parseLaunchEntry(entry.data);
    return parsed ? renderAgentRunLaunch(parsed, theme) : undefined;
  });
  pi.on("tool_execution_end", (event) => {
    if (event.toolName !== "delegate_agent" || event.isError) return;
    const entry = launchEntry(event.result?.details);
    if (entry) pi.appendEntry(AGENT_RUN_LAUNCH_ENTRY_TYPE, entry);
  });
};
