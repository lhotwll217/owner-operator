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
import { connectGateway } from "../gateway/client";
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
  assert.equal((await gateway!.ready()).ready, true);

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
