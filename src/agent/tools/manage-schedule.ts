import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import type { GatewayApi, ScheduleCreateInput, ScheduleDefinition } from "@owner-operator/core";
import { resolveBackend } from "../../gateway/client";

type ManageScheduleBackend = Pick<GatewayApi, "listSchedules" | "updateSchedule" | "deleteSchedule">;

export interface ManageScheduleRequest {
  action: "disable" | "delete";
  id: string;
}

export async function manageSchedule(
  backend: ManageScheduleBackend,
  request: ManageScheduleRequest,
): Promise<
  | { action: "disable"; schedule: ScheduleDefinition }
  | { action: "delete"; id: string; deleted: true }
> {
  if (request.action === "delete") {
    await backend.deleteSchedule(request.id);
    return { action: request.action, id: request.id, deleted: true } as const;
  }
  const schedule = (await backend.listSchedules()).find(({ id }) => id === request.id);
  if (!schedule) throw new Error(`schedule not found: ${request.id}`);
  const input: ScheduleCreateInput = {
    name: schedule.name,
    enabled: false,
    trigger: schedule.trigger,
    payload: schedule.payload,
    cwd: schedule.cwd,
    timeoutSeconds: schedule.timeoutSeconds,
  };
  return {
    action: request.action,
    schedule: await backend.updateSchedule(schedule.id, input),
  };
}

export const manageScheduleTool = defineTool({
  name: "manage_schedule",
  label: "Manage schedule",
  description:
    "Disable or delete one durable Owner Operator schedule by its exact stable id. " +
    "Use query_database on schedules to find the id; names are not accepted.",
  parameters: Type.Object({
    action: Type.Union([
      Type.Literal("disable"),
      Type.Literal("delete"),
    ], { description: "disable | delete." }),
    id: Type.String({ minLength: 1, description: "Exact stable schedule id from the schedules table." }),
  }),
  async execute(_id, params) {
    const backend = await resolveBackend();
    const result = await manageSchedule(backend, params);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      details: result,
    };
  },
});
