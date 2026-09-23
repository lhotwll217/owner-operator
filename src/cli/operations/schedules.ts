import { readFileSync } from "node:fs";
import type { ScheduleCreateInput, ScheduleDefinition, ScheduleRun } from "@owner-operator/core";
import { emit, gateway, UsageError, type Noun, type VerbValues } from "./operation";

const FROM = {
  from: {
    type: "string" as const,
    help: "JSON file, or - for stdin, in the POST /schedules body shape",
  },
};

/** The schedule body is the Gateway's own contract; the CLI only reads it and forwards it. */
function readScheduleInput(values: VerbValues): ScheduleCreateInput {
  const source = values.from;
  if (typeof source !== "string") throw new UsageError("--from <file|-> is required");
  const raw = readFileSync(source === "-" ? 0 : source, "utf8");
  try {
    return JSON.parse(raw) as ScheduleCreateInput;
  } catch (error) {
    throw new UsageError(`--from is not valid JSON: ${(error as Error).message}`);
  }
}

const scheduleLine = (schedule: ScheduleDefinition): string =>
  `${schedule.id}  ${schedule.enabled ? "enabled " : "disabled"}  ${schedule.trigger.kind.padEnd(8)} next=${schedule.nextRunAt ?? "-"}  ${schedule.name}`;

const runLine = (run: ScheduleRun): string =>
  `run ${run.id} of ${run.scheduleId}: ${run.status}${run.error ? ` — ${run.error}` : ""}`;

export const schedules: Noun = {
  summary: "durable prompt and command schedules (/schedules)",
  verbs: {
    list: {
      summary: "every schedule",
      async run({ json }) {
        const all = await (await gateway()).listSchedules();
        emit(json, all, () => all.length ? all.map(scheduleLine).join("\n") : "no schedules");
        return 0;
      },
    },
    create: {
      summary: "create a schedule from a POST /schedules body",
      options: FROM,
      async run({ values, json }) {
        const created = await (await gateway()).createSchedule(readScheduleInput(values));
        emit(json, created, () => scheduleLine(created));
        return 0;
      },
    },
    update: {
      args: "<id>",
      summary: "replace a schedule from a PUT /schedules/:id body",
      options: FROM,
      minPositionals: 1,
      async run({ positionals: [id], values, json }) {
        const updated = await (await gateway()).updateSchedule(id!, readScheduleInput(values));
        emit(json, updated, () => scheduleLine(updated));
        return 0;
      },
    },
    delete: {
      args: "<id>",
      summary: "delete a schedule",
      minPositionals: 1,
      async run({ positionals: [id], json }) {
        const result = await (await gateway()).deleteSchedule(id!);
        emit(json, result, () => `deleted ${id}`);
        return 0;
      },
    },
    run: {
      args: "<id>",
      summary: "start one run now; returns the run record",
      minPositionals: 1,
      async run({ positionals: [id], json }) {
        const run = await (await gateway()).runSchedule(id!);
        emit(json, run, () => runLine(run));
        return 0;
      },
    },
  },
};
