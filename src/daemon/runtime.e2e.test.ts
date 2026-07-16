import assert from "node:assert";
import { statSync } from "node:fs";
import { join } from "node:path";
import {
  DatabaseQueryAction,
  GatewayEventKind,
  ScheduleKind,
  ScheduledPayloadKind,
  type GatewayEvent,
  type ScheduleExecutionResult,
} from "@owner-operator/core";
import { manageScheduleTool } from "../agent/tools/manage-schedule";
import { queryDatabaseTool } from "../agent/tools/query-database";
import { connectGateway } from "../gateway/client";
import { fakeScanRow, tempOoHome, waitFor } from "../gateway/test/helpers";
import { startDaemon } from "./runtime";

const { dir, cleanup } = tempOoHome("oo-daemon-e2e");
const toolContext = {} as Parameters<typeof manageScheduleTool.execute>[4];
let releaseSlowRun: () => void = () => undefined;
const slowRunRelease = new Promise<void>((resolve) => { releaseSlowRun = resolve; });
const daemon = await startDaemon({
  port: 0,
  dbPath: join(dir, "state.db"),
  watch: false,
  enableEnrichment: false,
  monitor: { scan: async () => [fakeScanRow()], intervalMs: 60_000 },
  scheduler: {
    tickMs: 60_000,
    commandRunner: async ({ argv }): Promise<ScheduleExecutionResult> => {
      if (argv[1] === "slow.mjs") await slowRunRelease;
      return { exitCode: 0, stdout: "ran\n", stderr: "" };
    },
  },
});

try {
  assert.ok(statSync(join(dir, "workspace", "AGENTS.md")).isFile(), "daemon entry creates the owned workspace");
  await waitFor(() => daemon.state.listSessionState().length === 1, 1_000, "initial monitor poll");
  const unauthenticated = await fetch(`http://127.0.0.1:${daemon.port}/health`);
  assert.equal(unauthenticated.status, 401, "every Gateway route requires the discovery credential");
  assert.equal(statSync(join(dir, "daemon.json")).mode & 0o777, 0o600, "discovery credential is owner-readable only");
  const gateway = await connectGateway();
  assert.ok(gateway, "ready daemon is discoverable");
  assert.equal((await gateway!.health()).fingerprint, daemon.fingerprint);
  const readiness = await gateway!.ready();
  assert.equal(readiness.ready, true);
  assert.equal(readiness.setupRequired, true, "fresh daemon reports setup required without scanning credentials");

  const events: GatewayEvent[] = [];
  const unsubscribe = gateway!.subscribe((event) => events.push(event));
  const done = await gateway!.markDone(["abc-123"]);
  assert.equal(done.marked[0].id, "abc-123");
  await waitFor(() => events.some((event) => event.kind === GatewayEventKind.StateChanged), 1_000, "state invalidation");

  const schedule = await gateway!.createSchedule({
    name: "check",
    enabled: true,
    trigger: { kind: ScheduleKind.Every, everyMs: 60_000, anchorMs: Date.now() },
    payload: { kind: ScheduledPayloadKind.Command, argv: ["node", "check.mjs"] },
    cwd: dir,
    timeoutSeconds: 600,
  });
  await gateway!.runSchedule(schedule.id);
  const runs = await gateway!.queryDatabase({
    action: DatabaseQueryAction.Query,
    sql: "SELECT status, stdout_tail FROM schedule_runs ORDER BY created_at DESC LIMIT 1",
  }) as { rows: Array<{ status: string; stdout_tail: string }> };
  assert.deepEqual(runs.rows[0], { status: "completed", stdout_tail: "ran\n" });

  const discoveredResult = await queryDatabaseTool.execute(
    "discover-schedule",
    { action: DatabaseQueryAction.Query, sql: "SELECT id FROM schedules WHERE name = 'check'" },
    undefined,
    undefined,
    toolContext,
  );
  const discoveryText = discoveredResult.content.find(({ type }) => type === "text");
  assert.ok(discoveryText && discoveryText.type === "text");
  const discovered = JSON.parse(discoveryText.text) as { rows: Array<{ id: string }> };
  assert.equal(discovered.rows[0]?.id, schedule.id, "the read-only Operator tool identifies the stable schedule id");
  const discoveredScheduleId = discovered.rows[0].id;

  const disabledResult = await manageScheduleTool.execute(
    "disable-schedule",
    { action: "disable", id: discoveredScheduleId },
    undefined,
    undefined,
    toolContext,
  );
  assert.equal(disabledResult.details.action, "disable");
  const disabledSchedule = (await gateway!.listSchedules()).find(({ id }) => id === schedule.id);
  assert.deepEqual(disabledSchedule && {
    id: disabledSchedule.id,
    name: disabledSchedule.name,
    enabled: disabledSchedule.enabled,
    trigger: disabledSchedule.trigger,
    payload: disabledSchedule.payload,
    cwd: disabledSchedule.cwd,
    timeoutSeconds: disabledSchedule.timeoutSeconds,
    createdAt: disabledSchedule.createdAt,
  }, {
    id: schedule.id,
    name: schedule.name,
    enabled: false,
    trigger: schedule.trigger,
    payload: schedule.payload,
    cwd: schedule.cwd,
    timeoutSeconds: schedule.timeoutSeconds,
    createdAt: schedule.createdAt,
  }, "the public tool disables without replacing the schedule definition");
  await assert.rejects(
    () => manageScheduleTool.execute(
      "disable-missing",
      { action: "disable", id: "missing-schedule" },
      undefined,
      undefined,
      toolContext,
    ),
    /schedule not found: missing-schedule/,
    "an unknown stable id fails instead of selecting another schedule",
  );
  const deletedResult = await manageScheduleTool.execute(
    "delete-schedule",
    { action: "delete", id: discoveredScheduleId },
    undefined,
    undefined,
    toolContext,
  );
  assert.deepEqual(deletedResult.details, { action: "delete", id: schedule.id, deleted: true });
  assert.ok(!(await gateway!.listSchedules()).some(({ id }) => id === schedule.id));
  const preservedRuns = await gateway!.queryDatabase({
    action: DatabaseQueryAction.Query,
    sql: `SELECT COUNT(*) AS count FROM schedule_runs WHERE schedule_id = '${schedule.id}'`,
  }) as { rows: Array<{ count: number }> };
  assert.equal(preservedRuns.rows[0]?.count, 1, "public-tool deletion preserves run history");
  await assert.rejects(
    () => manageScheduleTool.execute(
      "delete-missing",
      { action: "delete", id: "missing-schedule" },
      undefined,
      undefined,
      toolContext,
    ),
    /gateway \/schedules\/missing-schedule: 404/,
    "deleting an unknown stable id fails explicitly",
  );

  const slowSchedule = await gateway!.createSchedule({
    name: "slow check",
    enabled: false,
    trigger: { kind: ScheduleKind.NeedsYou },
    payload: { kind: ScheduledPayloadKind.Command, argv: ["node", "slow.mjs"] },
    cwd: dir,
    timeoutSeconds: 600,
  });
  const trigger = gateway!.runSchedule(slowSchedule.id);
  const triggerOutcome = await Promise.race([
    trigger.then(() => "accepted" as const),
    new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 50)),
  ]);
  releaseSlowRun();
  assert.equal(triggerOutcome, "accepted", "manual runs are accepted without waiting for execution");
  assert.equal((await trigger).status, "running", "the immediate response is the durable running row");
  await waitFor(
    () => daemon.state.listScheduleRuns(slowSchedule.id)[0]?.status === "completed",
    1_000,
    "manual run completion",
  );

  unsubscribe();
  gateway!.close();
  process.stdout.write("ok — daemon composition and gateway e2e\n");
} finally {
  await daemon.close();
  assert.equal(await connectGateway(), null, "closed daemon removes discovery");
  cleanup();
}
