import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ScheduleKind,
  ScheduledPayloadKind,
  ScheduleRunStatus,
  ScheduleRunTrigger,
  type ScheduleExecutionResult,
} from "@owner-operator/core";
import { State } from "../state/state";
import { Scheduler, SchedulerLogEvent, type SchedulerLogRecord } from "./scheduler";

const dir = mkdtempSync(join(tmpdir(), "oo-scheduler-"));
let nowMs = Date.parse("2026-07-09T10:00:00.000Z");
const state = new State(join(dir, "state.db"), { now: () => new Date(nowMs).toISOString() });
const executions: string[][] = [];
const claimedNextRuns: Array<string | null | undefined> = [];
const logs: SchedulerLogRecord[] = [];
let signalSlowStarted: () => void = () => undefined;
let releaseSlow: () => void = () => undefined;
const slowStarted = new Promise<void>((resolve) => { signalSlowStarted = resolve; });
const slowReleased = new Promise<void>((resolve) => { releaseSlow = resolve; });

const scheduler = new Scheduler(state, {
  now: () => nowMs,
  commandRunner: async ({ argv }): Promise<ScheduleExecutionResult> => {
    executions.push([...argv]);
    if (argv[1] === "health.mjs") {
      claimedNextRuns.push(state.listSchedules().find((schedule) => schedule.name === "health check")?.nextRunAt);
    }
    if (argv[1] === "slow.mjs") {
      signalSlowStarted();
      await slowReleased;
    }
    return { exitCode: 0, stdout: "ok\n", stderr: "" };
  },
  logger: (record) => logs.push(record),
});

try {
  const job = scheduler.createSchedule({
    name: "health check",
    enabled: true,
    trigger: { kind: ScheduleKind.Every, everyMs: 60_000, anchorMs: nowMs },
    payload: { kind: ScheduledPayloadKind.Command, argv: ["node", "health.mjs"] },
    cwd: dir,
    timeoutSeconds: 600,
  });
  assert.equal(job.nextRunAt, "2026-07-09T10:01:00.000Z");

  nowMs += 60_000;
  await scheduler.tick();
  assert.deepEqual(executions, [["node", "health.mjs"]]);
  assert.deepEqual(claimedNextRuns, ["2026-07-09T10:02:00.000Z"], "timer occurrence is advanced before work starts");
  const completed = state.listScheduleRuns(job.id)[0];
  assert.equal(completed.status, ScheduleRunStatus.Completed);
  assert.equal(completed.stdoutTail, "ok\n");
  assert.ok(
    logs.some((record) => record.event === SchedulerLogEvent.RunFinished && record.runId === completed.id),
    "scheduler exposes structured run completion logs",
  );

  const manual = await scheduler.runNow(job.id);
  assert.equal(manual.status, ScheduleRunStatus.Completed);
  assert.equal(state.listScheduleRuns(job.id).length, 2, "manual run creates history instead of mutating the prior run");

  const edited = scheduler.updateSchedule(job.id, {
    name: "health check renamed",
    enabled: true,
    trigger: job.trigger,
    payload: job.payload,
    cwd: job.cwd,
    timeoutSeconds: job.timeoutSeconds,
  });
  assert.equal(edited.id, job.id);
  assert.equal(edited.createdAt, job.createdAt, "editing affects future runs without rewriting identity/history");

  const overdue = scheduler.createSchedule({
    name: "overdue one-shot",
    enabled: true,
    trigger: { kind: ScheduleKind.At, at: "2026-07-09T09:00:00.000Z" },
    payload: { kind: ScheduledPayloadKind.Command, argv: ["node", "once.mjs"] },
    cwd: dir,
    timeoutSeconds: 600,
  });
  await scheduler.tick();
  assert.equal(state.listScheduleRuns(overdue.id)[0].status, ScheduleRunStatus.Completed, "overdue one-shot runs once");
  assert.equal(state.scheduleById(overdue.id)?.enabled, false, "completed one-shot disables future triggers");

  state.createScheduleRun(job, ScheduleRunTrigger.Manual, null);
  state.markRunningScheduleRunsInterrupted("daemon restarted");
  assert.equal(state.listScheduleRuns(job.id)[0].status, ScheduleRunStatus.Interrupted);

  const changing = scheduler.createSchedule({
    name: "disable while active",
    enabled: true,
    trigger: { kind: ScheduleKind.Every, everyMs: 60_000, anchorMs: nowMs },
    payload: { kind: ScheduledPayloadKind.Command, argv: ["node", "slow.mjs"] },
    cwd: dir,
    timeoutSeconds: 600,
  });
  nowMs += 60_000;
  const activeTick = scheduler.tick();
  await slowStarted;
  scheduler.updateSchedule(changing.id, { ...changing, enabled: false });
  releaseSlow();
  await activeTick;
  assert.equal(state.scheduleById(changing.id)?.enabled, false, "an active run cannot undo a concurrent disable");

  const jobRunCount = state.listScheduleRuns(job.id).length;
  scheduler.deleteSchedule(job.id);
  scheduler.deleteSchedule(overdue.id);
  scheduler.deleteSchedule(changing.id);
  assert.equal(state.listSchedules().length, 0, "deleted jobs leave normal listings");
  assert.equal(state.listScheduleRuns(job.id).length, jobRunCount, "run history survives schedule deletion");

  const timeoutScheduler = new Scheduler(state);
  const timeoutJob = timeoutScheduler.createSchedule({
    name: "timeout keeps ownership",
    enabled: true,
    trigger: { kind: ScheduleKind.Every, everyMs: 60_000, anchorMs: Date.now() },
    payload: {
      kind: ScheduledPayloadKind.Command,
      argv: [process.execPath, "-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
    },
    cwd: dir,
    timeoutSeconds: 1,
  });
  const timedOutRun = timeoutScheduler.runNow(timeoutJob.id);
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  await assert.rejects(
    () => timeoutScheduler.runNow(timeoutJob.id),
    /already running/,
    "a timed-out child retains the non-overlap slot until it has exited",
  );
  const timedOut = await timedOutRun;
  assert.equal(timedOut.status, ScheduleRunStatus.Failed);
  assert.match(timedOut.error ?? "", /timed out/);
  timeoutScheduler.deleteSchedule(timeoutJob.id);
  await timeoutScheduler.stop();

  let shutdownStarted: () => void = () => undefined;
  const shutdownRunStarted = new Promise<void>((resolve) => { shutdownStarted = resolve; });
  let shutdownSignal: AbortSignal | undefined;
  const shutdownScheduler = new Scheduler(state, {
    commandRunner: async ({ signal }): Promise<ScheduleExecutionResult> => {
      shutdownSignal = signal;
      shutdownStarted();
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      return { exitCode: 1, stdout: "", stderr: "stopped" };
    },
  });
  const shutdownJob = shutdownScheduler.createSchedule({
    name: "shutdown drain",
    enabled: false,
    trigger: { kind: ScheduleKind.NeedsYou },
    payload: { kind: ScheduledPayloadKind.Command, argv: ["node", "wait.mjs"] },
    cwd: dir,
    timeoutSeconds: 600,
  });
  const activeAtShutdown = shutdownScheduler.runNow(shutdownJob.id);
  await shutdownRunStarted;
  await shutdownScheduler.stop();
  assert.equal(shutdownSignal?.aborted, true, "stop aborts active execution");
  assert.equal((await activeAtShutdown).status, ScheduleRunStatus.Interrupted, "shutdown records an interrupted run");

  process.stdout.write("ok — public scheduler seam\n");
} finally {
  await scheduler.stop();
  state.close();
  rmSync(dir, { recursive: true, force: true });
}
