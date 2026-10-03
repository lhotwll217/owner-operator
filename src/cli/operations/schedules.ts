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

/** Every field of a route record, one `field: value` line each. Values are JSON, so the text carries
 * the whole record (trigger, payload arguments, timeout, ...) and parses back to it. */
export const recordText = (record: ScheduleDefinition | ScheduleRun | { ok: true }): string =>
  Object.entries(record).map(([field, value]) => `${field}: ${JSON.stringify(value)}`).join("\n");

const scheduleLine = recordText;
const runLine = recordText;

export const schedules: Noun = {
  summary: "durable prompt and command schedules (/schedules)",
  useWhen: "seeing, creating, changing, deleting, or triggering recurring prompts and commands",
  verbs: {
    list: {
      summary: "every schedule",
      examples: ["oo schedules list", "oo schedules list --json"],
      async run({ json }) {
        const all = await (await gateway()).listSchedules();
        await emit(json, all, () => all.length ? all.map(scheduleLine).join("\n\n") : "no schedules");
        return 0;
      },
    },
    create: {
      summary: "create a schedule from a POST /schedules body",
      options: FROM,
      examples: ["oo schedules create --from schedule.json", "oo schedules create --from schedule.json --json"],
      async run({ values, json }) {
        const created = await (await gateway()).createSchedule(readScheduleInput(values));
        await emit(json, created, () => scheduleLine(created));
        return 0;
      },
    },
    update: {
      args: "<id>",
      summary: "replace a schedule from a PUT /schedules/:id body",
      options: FROM,
      minPositionals: 1,
      examples: ["oo schedules update <id> --from schedule.json"],
      async run({ positionals: [id], values, json }) {
        const updated = await (await gateway()).updateSchedule(id!, readScheduleInput(values));
        await emit(json, updated, () => scheduleLine(updated));
        return 0;
      },
    },
    delete: {
      args: "<id>",
      summary: "delete a schedule",
      minPositionals: 1,
      examples: ["oo schedules delete <id>"],
      async run({ positionals: [id], json }) {
        const result = await (await gateway()).deleteSchedule(id!);
        await emit(json, result, () => recordText(result));
        return 0;
      },
    },
    run: {
      args: "<id>",
      summary: "start one run now; returns the run record",
      minPositionals: 1,
      examples: ["oo schedules run <id>", "oo schedules run <id> --json"],
      async run({ positionals: [id], json }) {
        const run = await (await gateway()).runSchedule(id!);
        await emit(json, run, () => runLine(run));
        return 0;
      },
    },
  },
};
