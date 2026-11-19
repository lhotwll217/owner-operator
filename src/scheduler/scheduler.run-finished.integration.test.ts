import assert from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentRunHarness,
  AgentRunStatus,
  ScheduleKind,
  ScheduleRunStatus,
  ScheduleRunTrigger,
  ScheduledPayloadKind,
  type AgentRun,
  type AgentRunFinalStatus,
  type ScheduleCreateInput,
  type ScheduleExecutionResult,
} from "@owner-operator/core";
import { AgentRunExecutor } from "../agent-runs/executor";
import { waitFor } from "../gateway/test/helpers";
import { State } from "../state/state";
import { Scheduler, type CommandExecutionRequest } from "./scheduler";

const dir = mkdtempSync(join(tmpdir(), "oo-scheduler-run-finished-"));
const dbPath = join(dir, "state.db");
const ORIGIN = "outside-caller";
const stdins: Array<string | undefined> = [];
const recordStdin = async ({ stdin }: CommandExecutionRequest): Promise<ScheduleExecutionResult> => {
  stdins.push(stdin);
  return { exitCode: 0, stdout: "", stderr: "" };
};
const pause = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

const wake = (name: string, origin: string, argv: [string, ...string[]]): ScheduleCreateInput => ({
  name,
  enabled: true,
  trigger: { kind: ScheduleKind.RunFinished, origin },
  payload: { kind: ScheduledPayloadKind.Command, argv },
  cwd: dir,
  timeoutSeconds: 30,
});

const startRun = (state: State, origin: string | null): AgentRun => state.createAgentRun({
  harness: AgentRunHarness.Codex, task: "outside task", cwd: dir, depth: 1, timeoutSeconds: 60, origin,
});

const finishRun = (state: State, origin: string | null, status: AgentRunFinalStatus): AgentRun =>
  state.finishAgentRun(startRun(state, origin).id, { status, resultTail: null, error: null })!;

const contextOf = (run: AgentRun) => ({
  runId: run.id, status: run.status, origin: run.origin, finishedAt: run.finishedAt,
});

let state = new State(dbPath);
let scheduler = new Scheduler(state, { tickMs: 60_000, commandRunner: recordStdin });

try {
  for (const origin of [undefined, "", "  ", 7]) {
    assert.throws(
      () => scheduler.createSchedule(wake("no origin", origin as never, ["/bin/true"])),
      /origin/,
      `run-finished schedule with origin ${JSON.stringify(origin)} is rejected`,
    );
  }

  finishRun(state, ORIGIN, AgentRunStatus.Completed);
  await pause(5);
  const job = scheduler.createSchedule(wake("wake outside caller", ORIGIN, ["/bin/sh", "/absolute/wake.sh"]));
  assert.equal(job.nextRunAt, null, "an event trigger has no timer occurrence");
  scheduler.start();
  await pause();
  assert.equal(stdins.length, 0, "a run that finished before the schedule existed never fires");

  const statuses = [AgentRunStatus.Completed, AgentRunStatus.Failed, AgentRunStatus.Cancelled, AgentRunStatus.Interrupted] as const;
  for (const [index, status] of statuses.entries()) {
    const run = finishRun(state, ORIGIN, status);
    await waitFor(() => stdins.length === index + 1, 1_000, `${status} origin run fires`);
    assert.deepStrictEqual(JSON.parse(stdins[index]!), contextOf(run), `${status} run context reaches stdin`);
  }

  finishRun(state, "someone-else", AgentRunStatus.Completed);
  finishRun(state, null, AgentRunStatus.Completed);
  await pause();
  await scheduler.tick();
  await pause();
  assert.equal(stdins.length, 4, "another origin's run and a local run fire nothing");

  const lost = startRun(state, ORIGIN);
  assert.equal(state.claimNextPendingAgentRun(10)?.id, lost.id);
  await pause(5);
  new AgentRunExecutor(state, { launcher: async () => { throw new Error("never launched"); }, lostGraceMs: 0 })
    .sweepLostRuns();
  await waitFor(() => stdins.length === 5, 1_000, "lost origin run fires");
  assert.deepStrictEqual(JSON.parse(stdins[4]!), contextOf(state.agentRunById(lost.id)!));
  assert.equal(JSON.parse(stdins[4]!).status, AgentRunStatus.Lost);

  const history = state.listScheduleRuns(job.id);
  assert.equal(history.length, 5, "one schedule run per finished origin run");
  assert.ok(history.every((run) => run.trigger === ScheduleRunTrigger.RunFinished && run.status === ScheduleRunStatus.Completed));

  const downtime = startRun(state, ORIGIN);
  assert.equal(state.claimNextPendingAgentRun(10)?.id, downtime.id);
  await scheduler.stop();
  state.close();

  state = new State(dbPath);
  assert.deepStrictEqual(state.markRunningAgentRunsInterrupted("daemon restarted during execution"), [downtime.id]);
  scheduler = new Scheduler(state, { tickMs: 60_000, commandRunner: recordStdin });
  scheduler.start();
  await waitFor(() => stdins.length === 6, 1_000, "run that ended while the scheduler was down fires after restart");
  assert.deepStrictEqual(JSON.parse(stdins[5]!), contextOf(state.agentRunById(downtime.id)!));
  await scheduler.tick();
  await pause();
  assert.equal(stdins.length, 6, "a later tick does not refire a claimed run");
  await scheduler.stop();
  state.close();

  state = new State(dbPath);
  scheduler = new Scheduler(state, { tickMs: 60_000 });
  scheduler.start();
  await pause();
  await scheduler.tick();
  await pause();
  assert.equal(state.listScheduleRuns(job.id).length, 6, "a second restart fires nothing more");

  const out = join(dir, "context.json");
  const reader = scheduler.createSchedule(wake("shell reads stdin", "shell-caller", ["/bin/sh", "-c", `cat > '${out}'`]));
  const ignorer = scheduler.createSchedule(wake("shell ignores stdin", "shell-caller", ["/bin/sh", "-c", "exit 0"]));
  await pause(5);
  const spawned = finishRun(state, "shell-caller", AgentRunStatus.Completed);
  await waitFor(
    () => [reader, ignorer].every((schedule) => state.listScheduleRuns(schedule.id)[0]?.status === ScheduleRunStatus.Completed),
    5_000,
    "both real commands finish",
  );
  assert.ok(existsSync(out));
  assert.deepStrictEqual(JSON.parse(readFileSync(out, "utf8")), contextOf(spawned), "real command reads context JSON on stdin");
  assert.equal(state.listScheduleRuns(ignorer.id)[0]?.exitCode, 0, "a command that never reads stdin still succeeds");
  assert.equal(state.listScheduleRuns(job.id).length, 6, "another origin's schedule stays quiet");

  const manual = await scheduler.runNow(reader.id);
  await waitFor(
    () => state.listScheduleRuns(reader.id).find((run) => run.id === manual.id)?.status === ScheduleRunStatus.Completed,
    5_000,
    "manual run of a stdin reader finishes",
  );
  assert.equal(readFileSync(out, "utf8"), "", "a run without trigger context gives the command an empty stdin");
  process.stdout.write("ok — run-finished fires once per terminal origin run across restart and lost, with context on stdin\n");
} finally {
  await scheduler.stop();
  state.close();
  rmSync(dir, { recursive: true, force: true });
}
