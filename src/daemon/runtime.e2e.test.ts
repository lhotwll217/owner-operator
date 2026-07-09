import assert from "node:assert";
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
const daemon = await startDaemon({
  port: 0,
  dbPath: join(dir, "state.db"),
  watch: false,
  enableEnrichment: false,
  monitor: { scan: async () => [fakeScanRow()], intervalMs: 60_000 },
  scheduler: {
    tickMs: 60_000,
    commandRunner: async (): Promise<ScheduleExecutionResult> => ({ exitCode: 0, stdout: "ran\n", stderr: "" }),
  },
});

try {
  await waitFor(() => daemon.state.listSessionState().length === 1, 1_000, "initial monitor poll");
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

  unsubscribe();
  gateway!.close();
  process.stdout.write("ok — daemon composition and gateway e2e\n");
} finally {
  await daemon.close();
  assert.equal(await connectGateway(), null, "closed daemon removes discovery");
  cleanup();
}
