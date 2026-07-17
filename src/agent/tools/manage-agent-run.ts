import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import type { AgentRun, GatewayApi } from "@owner-operator/core";
import { resolveBackend } from "../../gateway/client";

/** The manage_agent_run actions, declared once so the runtime schema and the request type can't
 * drift. The compile-time `action` type and the model-facing Type.Union both derive from this. */
const MANAGE_AGENT_RUN_ACTIONS = ["status", "cancel", "resume", "wait"] as const;
type ManageAgentRunAction = (typeof MANAGE_AGENT_RUN_ACTIONS)[number];

type ManageAgentRunBackend = Pick<
  GatewayApi,
  "agentRun" | "cancelAgentRun" | "resumeAgentRun" | "waitAgentRun"
>;

export interface ManageAgentRunRequest {
  action: ManageAgentRunAction;
  id: string;
  waitSeconds?: number;
}

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
    case "wait":
      return backend.waitAgentRun(request.id, request.waitSeconds ?? 60);
  }
}

export const manageAgentRunTool = defineTool({
  name: "manage_agent_run",
  label: "Manage agent run",
  description:
    "Inspect or control one delegated run by its exact run id: status (read the current row), " +
    "cancel (abort a running or queued run), resume (start a new run continuing an interrupted/lost/failed " +
    "run's child session), or wait (block for the result). Use query_database on agent_runs to find ids.",
  parameters: Type.Object({
    action: Type.Union(
      MANAGE_AGENT_RUN_ACTIONS.map((action) => Type.Literal(action)),
      { description: "status | cancel | resume | wait." },
    ),
    id: Type.String({ minLength: 1, description: "Exact stable run id from the agent_runs table." }),
    waitSeconds: Type.Optional(Type.Integer({
      minimum: 1,
      maximum: 3_600,
      description: "For action=wait: how long to block for the result. Default 60.",
    })),
  }),
  async execute(_id, params) {
    const backend = await resolveBackend();
    const run = await manageAgentRun(backend, params);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(run, null, 2) }],
      details: run,
    };
  },
});
