import { AgentToolId } from "@owner-operator/core";
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

// `read` is a blacklist-aware override. `bash` is a same-name argv-only override that can
// run only the session-search skill helper; it is not a general shell.
export const ownerOperatorTools: readonly AgentToolId[] = [
  AgentToolId.Bash,
  AgentToolId.Read,
  AgentToolId.GetCurrentSessionState,
  AgentToolId.MarkThreadDone,
  AgentToolId.QueryDatabase,
  AgentToolId.SchedulePrompt,
];
