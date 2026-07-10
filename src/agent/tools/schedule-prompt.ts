import { isAbsolute, resolve } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import {
  AgentToolId,
  ScheduleKind,
  ScheduledPayloadKind,
  type ScheduleTrigger,
} from "@owner-operator/core";
import { resolveBackend } from "../../gateway/client";

const AgentToolIdSchema = Type.Union(Object.values(AgentToolId).map((tool) => Type.Literal(tool)));
const ScheduleTriggerSchema = Type.Union([
  Type.Object({ kind: Type.Literal(ScheduleKind.At), at: Type.String({ description: "Absolute ISO timestamp." }) }),
  Type.Object({
    kind: Type.Literal(ScheduleKind.Every),
    everyMs: Type.Integer({ minimum: 1_000 }),
    anchorMs: Type.Optional(Type.Integer({ minimum: 0 })),
  }),
  Type.Object({
    kind: Type.Literal(ScheduleKind.Cron),
    expression: Type.String(),
    timeZone: Type.String({ description: "IANA time zone, for example Europe/Helsinki." }),
  }),
  Type.Object({ kind: Type.Literal(ScheduleKind.NeedsYou) }),
]);

export const schedulePromptTool = defineTool({
  name: "schedule_prompt",
  label: "Schedule prompt",
  description:
    "Create a durable Owner Operator prompt job. Each run uses a fresh isolated session; " +
    "use query_database on schedules and schedule_runs to inspect status or failures.",
  parameters: Type.Object({
    name: Type.String({ description: "Short human-readable job name." }),
    schedule: ScheduleTriggerSchema,
    prompt: Type.String({ description: "Prompt executed in each fresh isolated run." }),
    toolsAllow: Type.Optional(Type.Array(AgentToolIdSchema, {
      description: "Concrete typed tool ids available to the scheduled agent. No buckets or profiles.",
    })),
    cwd: Type.Optional(Type.String({ description: "Absolute working directory. Defaults to the caller's cwd." })),
    timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 86_400, description: "Default 1800." })),
  }),
  async execute(_id, params) {
    const cwd = params.cwd ? (isAbsolute(params.cwd) ? params.cwd : resolve(params.cwd)) : process.cwd();
    const trigger: ScheduleTrigger = params.schedule.kind === ScheduleKind.Every
      ? {
          kind: ScheduleKind.Every,
          everyMs: params.schedule.everyMs,
          anchorMs: params.schedule.anchorMs ?? Date.now(),
        }
      : params.schedule as ScheduleTrigger;
    const schedule = await (await resolveBackend()).createSchedule({
      name: params.name,
      enabled: true,
      trigger,
      payload: {
        kind: ScheduledPayloadKind.Prompt,
        prompt: params.prompt,
        ...(params.toolsAllow ? { toolsAllow: params.toolsAllow as AgentToolId[] } : {}),
      },
      cwd,
      timeoutSeconds: params.timeoutSeconds ?? 1_800,
    });
    return {
      content: [{ type: "text" as const, text: JSON.stringify(schedule, null, 2) }],
      details: schedule,
    };
  },
});
