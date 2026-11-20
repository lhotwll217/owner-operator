import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentRunHarness,
  AgentRunStatus,
  ScheduleKind,
  ScheduleRunStatus,
  ScheduledPayloadKind,
  type AgentRun,
  type ScheduleCreateInput,
  type ScheduleExecutionResult,
} from "@owner-operator/core";
import { AgentRunExecutor } from "../agent-runs/executor";
import { waitFor } from "../gateway/test/helpers";
import { State } from "../state/state";
import { Scheduler, type CommandExecutionRequest } from "./scheduler";

const dir = mkdtempSync(join(tmpdir(), "oo-scheduler-run-finished-delivery-"));
const pause = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms));
const ok: ScheduleExecutionResult = { exitCode: 0, stdout: "", stderr: "" };
type Runner = (request: CommandExecutionRequest) => Promise<ScheduleExecutionResult>;

const wake = (name: string, origin: string, enabled = true): ScheduleCreateInput => ({
  name,
  enabled,
  trigger: { kind: ScheduleKind.RunFinished, origin },
  payload: { kind: ScheduledPayloadKind.Command, argv: ["/bin/true", name] },
  cwd: dir,
  timeoutSeconds: 30,
});

const finishRun = (state: State, origin: string): AgentRun => {
  const run = state.createAgentRun({
    harness: AgentRunHarness.Codex, task: "outside task", cwd: dir, depth: 1, timeoutSeconds: 60, origin,
  });
  return state.finishAgentRun(run.id, { status: AgentRunStatus.Completed, resultTail: null, error: null })!;
};

const contextOf = (run: AgentRun) => JSON.stringify({
  runId: run.id, status: run.status, origin: run.origin, finishedAt: run.finishedAt,
});

/** Wakes recorded as `name` → stdin per call; a name in `blocked` waits until released or aborted. */
function recorder() {
  const wakes = new Map<string, Array<string | undefined>>();
  const blocked = new Map<string, () => void>();
  const runner: Runner = async ({ argv, signal, stdin }) => {
    const name = argv[1]!;
    wakes.set(name, [...wakes.get(name) ?? [], stdin]);
    if (blocked.has(name)) {
      await new Promise<void>((resolve) => {
        blocked.set(name, resolve);
        signal.addEventListener("abort", () => resolve());
      });
    }
    return ok;
  };
  return { wakes, blocked, runner, of: (name: string) => wakes.get(name) ?? [] };
}

let n = 0;
const failures: string[] = [];
async function scenario(
  name: string,
  body: (open: (runner: Runner, clock?: number) => { state: State; scheduler: Scheduler }) => Promise<void>,
): Promise<void> {
  const dbPath = join(dir, `state-${n++}.db`);
  const opened: Array<{ state: State; scheduler: Scheduler }> = [];
  const open = (runner: Runner, clock?: number) => {
    const state = new State(dbPath, clock === undefined ? {} : { now: () => new Date(clock).toISOString() });
    const scheduler = new Scheduler(state, { tickMs: 60_000, commandRunner: runner, ...(clock === undefined ? {} : { now: () => clock }) });
    opened.push({ state, scheduler });
    return { state, scheduler };
  };
  try {
    await body(open);
    process.stdout.write(`pass: ${name}\n`);
  } catch (error) {
    failures.push(name);
    process.stdout.write(`FAIL: ${name}: ${error instanceof Error ? error.message : String(error)}\n`);
  } finally {
    for (const { state, scheduler } of opened) {
      await scheduler.stop();
      try { state.close(); } catch { /* closed by the scenario */ }
    }
  }
}

try {
  await scenario("shutdown before the command starts", async (open) => {
    const first = recorder();
    const { state, scheduler } = open(first.runner);
    const blocker = scheduler.createSchedule(wake("a blocker", "blocker-origin"));
    scheduler.createSchedule(wake("b target", "target-origin"));
    scheduler.start();
    first.blocked.set("a blocker", () => undefined);
    await scheduler.runNow(blocker.id);
    await waitFor(() => first.of("a blocker").length === 1, 1_000, "blocker holds the execution queue");
    const run = finishRun(state, "target-origin");
    await pause();
    await scheduler.stop();
    state.close();

    const second = recorder();
    open(second.runner).scheduler.start();
    await waitFor(() => second.of("b target").length === 1, 2_000, "a wake queued at shutdown is delivered after restart");
    assert.equal(second.of("b target")[0], contextOf(run));
  });

  await scenario("runNow overtakes a queued wake", async (open) => {
    const calls = recorder();
    const { state, scheduler } = open(calls.runner);
    const blocker = scheduler.createSchedule(wake("a blocker", "blocker-origin"));
    const target = scheduler.createSchedule(wake("b target", "target-origin"));
    scheduler.start();
    calls.blocked.set("a blocker", () => undefined);
    await scheduler.runNow(blocker.id);
    await waitFor(() => calls.of("a blocker").length === 1, 1_000, "blocker holds the execution queue");
    const run = finishRun(state, "target-origin");
    await pause();
    await scheduler.runNow(target.id);
    calls.blocked.get("a blocker")!();
    await waitFor(() => calls.of("b target").length >= 1, 1_000, "manual run of the target executes");
    await scheduler.tick();
    await waitFor(() => calls.of("b target").includes(contextOf(run)), 2_000, "a wake overtaken by runNow is still delivered");
    await pause();
    assert.deepStrictEqual(calls.of("b target"), [undefined, contextOf(run)], "one manual run, then exactly one wake");
    assert.ok(
      state.listScheduleRuns(target.id).every((row) => row.status === ScheduleRunStatus.Completed),
      "no schedule run is stranded",
    );
  });

  await scenario("busy caller does not starve another", async (open) => {
    let aWakes = 0;
    let aWakesWhenZFired: number | undefined;
    const busy = open(async ({ argv }) => {
      if (argv[1] === "a") {
        aWakes += 1;
        if (aWakes < 20) finishRun(busy.state, "a-origin");
      } else {
        aWakesWhenZFired ??= aWakes;
      }
      return ok;
    });
    busy.scheduler.createSchedule(wake("a", "a-origin"));
    busy.scheduler.createSchedule(wake("z", "z-origin"));
    await pause(5);
    finishRun(busy.state, "a-origin");
    finishRun(busy.state, "z-origin");
    busy.scheduler.start();
    await waitFor(() => aWakesWhenZFired !== undefined, 5_000, "z fires");
    assert.ok(aWakesWhenZFired! <= 2, `z waited behind ${aWakesWhenZFired} of a's wakes, not a's backlog`);
  });

  await scenario("same-millisecond history", async (open) => {
    const calls = recorder();
    const { state, scheduler } = open(calls.runner, Date.parse("2026-11-20T12:00:00.000Z"));
    finishRun(state, "created");
    scheduler.createSchedule(wake("created", "created"));
    const disabled = scheduler.createSchedule(wake("reenabled", "reenabled", false));
    finishRun(state, "reenabled");
    scheduler.updateSchedule(disabled.id, wake("reenabled", "reenabled"));
    scheduler.start();
    await pause();
    await scheduler.tick();
    await pause();
    assert.deepStrictEqual([...calls.wakes.keys()], [], "a run that finished before create or re-enable, in the same millisecond, never fires");
    const after = finishRun(state, "created");
    const afterReenable = finishRun(state, "reenabled");
    await waitFor(() => calls.of("created").length === 1 && calls.of("reenabled").length === 1, 1_000, "same-millisecond later runs fire");
    assert.deepStrictEqual([calls.of("created")[0], calls.of("reenabled")[0]], [contextOf(after), contextOf(afterReenable)]);
  });

  await scenario("padded origin", async (open) => {
    const calls = recorder();
    const { state, scheduler } = open(calls.runner);
    scheduler.createSchedule(wake("padded", " caller "));
    scheduler.start();
    await pause(5);
    const executor = new AgentRunExecutor(state, { launcher: async () => { throw new Error("never launched"); } });
    const run = executor.launch({ harness: AgentRunHarness.Codex, task: "outside task", cwd: dir, origin: " caller " });
    await waitFor(() => calls.of("padded").length === 1, 2_000, "a padded origin matches the same padded value given to delegate");
    assert.equal(JSON.parse(calls.of("padded")[0]!).runId, run.id);
    await executor.stop();
  });

  assert.deepStrictEqual(failures, [], "every scenario passes");
  process.stdout.write("ok — run-finished wakes survive shutdown and runNow, round-robin across callers, skip same-ms history, and match origins as delegate does\n");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
