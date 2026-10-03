import assert from "node:assert";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
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
import { connectGateway } from "../gateway/client";
import { repoRoot } from "../shared/repo-root";
import { fakeScanRow, tempOoHome, waitFor } from "../gateway/test/helpers";
import { startDaemon } from "./runtime";

const { dir, cleanup } = tempOoHome("oo-daemon-e2e");
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
  let connected = false;
  const unsubscribe = gateway!.subscribe((event) => events.push(event), () => { connected = true; });
  await waitFor(() => connected, 1_000, "SSE connection before mutation");
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

  // The Operator's bash runs `oo` with OO_AGENT=1: connect to this daemon, never start one.
  // Async, because this process hosts the daemon that must answer.
  const agentOo = async (...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
    try {
      const { stdout, stderr } = await promisify(execFile)(join(repoRoot, "oo"), args,
        { cwd: repoRoot, env: { ...process.env, OO_AGENT: "1" } });
      return { code: 0, stdout, stderr };
    } catch (error) {
      const failed = error as { code: number; stdout: string; stderr: string };
      return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
    }
  };
  const discovery = await agentOo("db", "query", "SELECT id FROM schedules WHERE name = 'check'", "--json");
  const discovered = JSON.parse(discovery.stdout) as { rows: Array<{ id: string }> };
  assert.equal(discovered.rows[0]?.id, schedule.id, "the Operator's `oo db query` identifies the stable schedule id");
  const discoveredScheduleId = discovered.rows[0].id;

  const disabledResult = await agentOo("schedules", "disable", discoveredScheduleId, "--json");
  assert.equal(disabledResult.code, 0, disabledResult.stderr);
  const disabledSchedule = (await gateway!.listSchedules()).find(({ id }) => id === schedule.id);
  assert.deepEqual(JSON.parse(disabledResult.stdout), disabledSchedule, "disable prints the stored record");
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
  }, "`oo schedules disable` disables without replacing the schedule definition");
  const disableMissing = await agentOo("schedules", "disable", "missing-schedule");
  assert.equal(disableMissing.code, 1, "an unknown stable id fails instead of selecting another schedule");
  assert.match(disableMissing.stderr, /no such schedule: missing-schedule/);
  const deletedResult = await agentOo("schedules", "delete", discoveredScheduleId, "--json");
  assert.deepEqual(JSON.parse(deletedResult.stdout), { ok: true });
  assert.ok(!(await gateway!.listSchedules()).some(({ id }) => id === schedule.id));
  const preservedRuns = await gateway!.queryDatabase({
    action: DatabaseQueryAction.Query,
    sql: `SELECT COUNT(*) AS count FROM schedule_runs WHERE schedule_id = '${schedule.id}'`,
  }) as { rows: Array<{ count: number }> };
  assert.equal(preservedRuns.rows[0]?.count, 1, "deletion through oo preserves run history");
  const deleteMissing = await agentOo("schedules", "delete", "missing-schedule");
  assert.equal(deleteMissing.code, 1, "deleting an unknown stable id fails explicitly");
  assert.match(deleteMissing.stderr, /no such schedule: missing-schedule/);

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
    new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 3_000)),
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
