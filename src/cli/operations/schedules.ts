import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  AgentToolId,
  ScheduleKind,
  ScheduledPayloadKind,
  type ScheduleCreateInput,
  type ScheduleDefinition,
  type ScheduleRun,
  type ScheduleTrigger,
} from "@owner-operator/core";
import { emit, gateway, UsageError, type Noun, type VerbValues } from "./operation";

const FROM = {
  from: {
    type: "string" as const,
    help: "JSON file, or - for stdin, in the POST /schedules body shape",
  },
};

const PROMPT_FLAGS = {
  name: { type: "string" as const, help: "job name" },
  prompt: { type: "string" as const, help: "prompt run in a fresh isolated session each time" },
  at: { type: "string" as const, help: "trigger once at this ISO timestamp" },
  every: { type: "string" as const, help: "trigger every duration: 90s, 30m, 2h, 1d" },
  cron: { type: "string" as const, help: "trigger on this cron expression (needs --tz)" },
  tz: { type: "string" as const, help: "IANA time zone for --cron, e.g. Europe/Helsinki" },
  "needs-you": { type: "boolean" as const, help: "trigger when a session starts needing the owner" },
  tools: { type: "string" as const, help: "comma-separated tool ids the run may use, e.g. read,bash (default: all)" },
  cwd: { type: "string" as const, help: "working directory (default: current directory)" },
  timeout: { type: "string" as const, help: "seconds before a run is stopped (default 1800)" },
};

const DURATION_UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

function everyMs(duration: string): number {
  const match = /^(\d+)([smhd])$/.exec(duration);
  if (!match) throw new UsageError(`--every takes a duration such as 90s, 30m, 2h, or 1d, not "${duration}"`);
  return Number(match[1]) * DURATION_UNIT_MS[match[2]!]!;
}

function triggerFrom(values: VerbValues): ScheduleTrigger {
  const given = (["at", "every", "cron", "needs-you"] as const).filter((flag) => values[flag] !== undefined);
  if (given.length !== 1) throw new UsageError("exactly one of --at, --every, --cron, --needs-you is required");
  if ((values.tz !== undefined) !== (given[0] === "cron")) throw new UsageError("--tz goes with --cron, and --cron needs --tz");
  switch (given[0]) {
    case "at": return { kind: ScheduleKind.At, at: values.at as string };
    case "every": return { kind: ScheduleKind.Every, everyMs: everyMs(values.every as string), anchorMs: Date.now() };
    case "cron": return { kind: ScheduleKind.Cron, expression: values.cron as string, timeZone: values.tz as string };
    default: return { kind: ScheduleKind.NeedsYou };
  }
}

function toolsFrom(list: string): AgentToolId[] {
  const known = Object.values(AgentToolId) as string[];
  const tools = list.split(",").map((tool) => tool.trim()).filter(Boolean);
  const unknown = tools.find((tool) => !known.includes(tool));
  if (unknown !== undefined) throw new UsageError(`unknown tool "${unknown}"; tools are ${known.join(", ")}`);
  return tools as AgentToolId[];
}

/** A prompt schedule from flags, with the defaults the agent's old schedule tool applied. */
function promptScheduleInput(values: VerbValues): ScheduleCreateInput {
  if (typeof values.name !== "string" || typeof values.prompt !== "string") {
    throw new UsageError("--from <file|->, or --name and --prompt with a trigger, is required");
  }
  const timeout = values.timeout === undefined ? 1_800 : Number(values.timeout);
  if (!Number.isSafeInteger(timeout) || timeout < 1) throw new UsageError("--timeout takes a positive whole number of seconds");
  return {
    name: values.name,
    enabled: true,
    trigger: triggerFrom(values),
    payload: {
      kind: ScheduledPayloadKind.Prompt,
      prompt: values.prompt,
      ...(typeof values.tools === "string" ? { toolsAllow: toolsFrom(values.tools) } : {}),
    },
    cwd: resolve(typeof values.cwd === "string" ? values.cwd : process.cwd()),
    timeoutSeconds: timeout,
  };
}

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
      summary: "create a prompt schedule from flags, or any schedule from a POST /schedules body",
      options: { ...FROM, ...PROMPT_FLAGS },
      examples: [
        "oo schedules create --name standup --prompt 'Summarize what needs me.' --cron '0 9 * * 1-5' --tz Europe/Helsinki",
        "oo schedules create --name check-ci --prompt 'Check CI on main.' --every 2h --tools read,bash",
        "oo schedules create --name remind --prompt 'Remind me to ship.' --at 2026-10-04T09:00:00+03:00",
        "oo schedules create --from schedule.json --json",
      ],
      async run({ values, json }) {
        const flagged = Object.keys(PROMPT_FLAGS).some((flag) => values[flag] !== undefined);
        if (flagged && values.from !== undefined) throw new UsageError("--from carries the whole body; drop the other flags");
        const input = flagged ? promptScheduleInput(values) : readScheduleInput(values);
        const created = await (await gateway()).createSchedule(input);
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
    disable: {
      args: "<id>",
      summary: "stop a schedule from triggering; keeps it and its runs",
      minPositionals: 1,
      examples: ["oo schedules disable <id>", "oo schedules disable <id> --json"],
      async run({ positionals: [id], json }) {
        const api = await gateway();
        const schedule = (await api.listSchedules()).find((candidate) => candidate.id === id);
        if (!schedule) throw new Error(`no such schedule: ${id}`);
        const { name, trigger, payload, cwd, timeoutSeconds } = schedule;
        const updated = await api.updateSchedule(schedule.id, { name, enabled: false, trigger, payload, cwd, timeoutSeconds });
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
