import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import {
  validateAgentRunContinuationTask,
  type AgentRun,
  type GatewayApi,
} from "@owner-operator/core";
import { resolveBackend } from "../../gateway/client";
import { agentRunToolResult } from "./agent-run-result";

/** The manage_agent_run actions, declared once so the runtime schema and the request type can't
 * drift. The compile-time `action` type and the model-facing Type.Union both derive from this. */
const MANAGE_AGENT_RUN_TASKLESS_ACTIONS = ["status", "cancel", "resume"] as const;
const MANAGE_AGENT_RUN_ACTIONS = [...MANAGE_AGENT_RUN_TASKLESS_ACTIONS, "continue"] as const;
type ManageAgentRunAction = (typeof MANAGE_AGENT_RUN_ACTIONS)[number];

type ManageAgentRunBackend = Pick<
  GatewayApi,
  "agentRun" | "cancelAgentRun" | "resumeAgentRun" | "continueAgentRun"
>;

export type ManageAgentRunRequest =
  | { action: Exclude<ManageAgentRunAction, "continue">; id: string }
  | { action: "continue"; id: string; task: string };

export async function manageAgentRun(
  backend: ManageAgentRunBackend,
  request: ManageAgentRunRequest,
): Promise<AgentRun> {
  switch (request.action) {
    case "status":
      return backend.agentRun(request.id);
    case "cancel":
      return backend.cancelAgentRun(request.id);
    case "resume":
      return backend.resumeAgentRun(request.id);
    case "continue":
      return backend.continueAgentRun(request.id, validateAgentRunContinuationTask(request.task));
  }
}

export const manageAgentRunTool = defineTool({
  name: "manage_agent_run",
  label: "Manage agent run",
  description:
    "Control one delegated run by its exact run id. Completion events arrive automatically; this " +
    "tool is not for monitoring or polling. Use status only when the owner explicitly requests an " +
    "inspection: status (read the current row), cancel (abort a running or queued run), resume " +
    "(recover an interrupted/lost/failed run by replaying its task), continue (start a new run on " +
    "a completed child session with a required new follow-up task). Use " +
    "query_database on agent_runs to find ids.",
  parameters: Type.Union([
    Type.Object({
      action: Type.Union(
        MANAGE_AGENT_RUN_TASKLESS_ACTIONS.map((action) => Type.Literal(action)),
        { description: "status | cancel | resume." },
      ),
      id: Type.String({ minLength: 1, description: "Exact stable run id from the agent_runs table." }),
    }),
    Type.Object({
      action: Type.Literal("continue"),
      id: Type.String({ minLength: 1, description: "Exact completed run id from the agent_runs table." }),
      task: Type.String({ minLength: 1, description: "New follow-up task for the completed child session." }),
    }),
  ]),
  async execute(_id, params) {
    const backend = await resolveBackend();
    const run = await manageAgentRun(backend, params);
    return agentRunToolResult(run);
  },
});
