import assert from "node:assert";
import {
  ScheduleKind,
  ScheduledPayloadKind,
  type GatewayApi,
  type ScheduleCreateInput,
  type ScheduleDefinition,
} from "@owner-operator/core";
import { manageSchedule } from "./manage-schedule";

const schedule: ScheduleDefinition = {
  id: "schedule-1",
  name: "Daily review",
  enabled: true,
  trigger: { kind: ScheduleKind.Cron, expression: "0 9 * * *", timeZone: "Europe/Helsinki" },
  payload: { kind: ScheduledPayloadKind.Prompt, prompt: "Review the backlog." },
  cwd: "/tmp/example-repo",
  timeoutSeconds: 1_800,
  revision: 3,
  createdAt: "2026-07-10T00:00:00.000Z",
  updatedAt: "2026-07-10T00:00:00.000Z",
  nextRunAt: "2026-07-16T06:00:00.000Z",
};

let updated: { id: string; input: ScheduleCreateInput } | undefined;
let deletedId: string | undefined;
const backend = {
  async listSchedules() { return [schedule]; },
  async updateSchedule(id: string, input: ScheduleCreateInput) {
    updated = { id, input };
    return { ...schedule, ...input, revision: 4, nextRunAt: null };
  },
  async deleteSchedule(id: string) { deletedId = id; },
} as Pick<GatewayApi, "listSchedules" | "updateSchedule" | "deleteSchedule">;

const disabled = await manageSchedule(backend, { action: "disable", id: schedule.id });
assert.deepEqual(updated, {
  id: "schedule-1",
  input: {
    name: "Daily review",
    enabled: false,
    trigger: { kind: ScheduleKind.Cron, expression: "0 9 * * *", timeZone: "Europe/Helsinki" },
    payload: { kind: ScheduledPayloadKind.Prompt, prompt: "Review the backlog." },
    cwd: "/tmp/example-repo",
    timeoutSeconds: 1_800,
  },
});
assert.equal(disabled.action, "disable");
assert.equal("schedule" in disabled && disabled.schedule.enabled, false);

const deleted = await manageSchedule(backend, { action: "delete", id: schedule.id });
assert.equal(deletedId, "schedule-1");
assert.deepEqual(deleted, { action: "delete", id: "schedule-1", deleted: true });

process.stdout.write("ok — schedule management disables or deletes an exact stable id\n");
