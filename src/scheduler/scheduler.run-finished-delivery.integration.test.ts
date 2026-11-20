import assert from "node:assert";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AgentRunHarness,
  AgentRunStatus,
  ScheduleKind,
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
  await scenario("a hung command delays no other schedule", async (open) => {
    const calls = recorder();
    const { state, scheduler } = open(calls.runner);
    const past = (ms: number) => ({ kind: ScheduleKind.At, at: new Date(Date.now() - ms).toISOString() }) as const;
    scheduler.createSchedule({ ...wake("a hung", "unused"), trigger: past(2_000) });
    scheduler.createSchedule({ ...wake("b timer", "unused"), trigger: past(1_000) });
    scheduler.createSchedule(wake("c target", "target-origin"));
    calls.blocked.set("a hung", () => undefined);
    scheduler.start();
    await waitFor(() => calls.of("a hung").length === 1, 1_000, "the hung command is running");
    const run = finishRun(state, "target-origin");
    await waitFor(() => calls.of("b timer").length === 1, 1_000, "a due timer runs beside the hung command");
    await waitFor(() => calls.of("c target").length === 1, 1_000, "a wake fires beside the hung command");
    assert.equal(calls.of("c target")[0], contextOf(run));
  });

  await scenario("a wake waits for its schedule's own run", async (open) => {
    const calls = recorder();
    const { state, scheduler } = open(calls.runner);
    const target = scheduler.createSchedule(wake("target", "target-origin"));
    scheduler.start();
    calls.blocked.set("target", () => undefined);
    await scheduler.runNow(target.id);
    await waitFor(() => calls.of("target").length === 1, 1_000, "manual run is running");
    const release = calls.blocked.get("target")!;
    calls.blocked.delete("target");
    const run = finishRun(state, "target-origin");
    await scheduler.tick();
    await pause();
    assert.deepStrictEqual(calls.of("target"), [undefined], "the schedule never overlaps itself");
    release();
    await waitFor(() => calls.of("target").length === 2, 1_000, "the wake fires once the manual run ends");
    assert.equal(calls.of("target")[1], contextOf(run));
  });

  await scenario("clean stop mid-command", async (open) => {
    const first = recorder();
    const { state, scheduler } = open(first.runner);
    scheduler.createSchedule(wake("target", "target-origin"));
    scheduler.start();
    finishRun(state, "target-origin");
    await waitFor(() => first.of("target").length === 1, 1_000, "the first wake completes");
    first.blocked.set("target", () => undefined);
    const run = finishRun(state, "target-origin");
    await waitFor(() => first.of("target").length === 2, 1_000, "the second wake's command is running");
    await scheduler.stop();
    state.close();

    const second = recorder();
    open(second.runner).scheduler.start();
    await waitFor(() => second.of("target").length === 1, 2_000, "a wake stopped mid-command is retried after restart");
    await pause();
    assert.deepStrictEqual(second.of("target"), [contextOf(run)], "only the interrupted wake repeats, never the completed one");
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
    const executor = new AgentRunExecutor(state, { launcher: async () => { throw new Error("never launched"); } });
    const run = executor.launch({ harness: AgentRunHarness.Codex, model: "controlled", task: "outside task", cwd: dir, origin: " caller " });
    await waitFor(() => calls.of("padded").length === 1, 2_000, "a padded origin matches the same padded value given to delegate");
    assert.equal(JSON.parse(calls.of("padded")[0]!).runId, run.id);
    await executor.stop();
  });

  await scenario("daemon SIGKILLed as the wake command starts", async () => {
    const dbPath = join(dir, "crash.db");
    const setup = new State(dbPath);
    new Scheduler(setup).createSchedule({ ...wake("target", "target-origin"), payload: {
      kind: ScheduledPayloadKind.Command, argv: ["/bin/sh", "-c", "kill -9 $PPID"],
    } });
    const run = finishRun(setup, "target-origin");
    setup.close();
    const daemon = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./test/wake-daemon.ts", import.meta.url)), dbPath], { stdio: "inherit" });
    const [, signal] = await once(daemon, "exit");
    assert.equal(signal, "SIGKILL", "the wake command killed its daemon");

    const delivered: Array<string | undefined> = [];
    const state = new State(dbPath);
    const scheduler = new Scheduler(state, { tickMs: 60_000, commandRunner: async ({ stdin }) => { delivered.push(stdin); return ok; } });
    try {
      scheduler.start();
      await waitFor(() => delivered.length === 1, 2_000, "the killed wake is delivered after restart");
      assert.equal(delivered[0], contextOf(run));
    } finally {
      await scheduler.stop();
      state.close();
    }
  });

  await scenario("daemon SIGKILLed while the wake command keeps running", async () => {
    const dbPath = join(dir, "orphan.db");
    const log = join(dir, "orphan.log");
    const setup = new State(dbPath);
    new Scheduler(setup).createSchedule({ ...wake("target", "target-origin"), payload: {
      kind: ScheduledPayloadKind.Command,
      argv: ["/bin/sh", "-c", `echo "start $$" >> "$0"; sleep 3; echo "end $$" >> "$0"`, log],
    } });
    finishRun(setup, "target-origin");
    setup.close();
    const daemon = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./test/wake-daemon.ts", import.meta.url)), dbPath], { stdio: "inherit" });
    const events = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
    const state = new State(dbPath);
    const scheduler = new Scheduler(state, { tickMs: 60_000 });
    try {
      await waitFor(() => events().length === 1 && state.runningScheduleRunCommandPids().length === 1, 5_000, "the daemon's wake command is running");
      daemon.kill("SIGKILL");
      await once(daemon, "exit");
      scheduler.start();
      await waitFor(() => events().length >= 2, 2_000, "the wake is retried after restart");
      await pause(3_500);
      const [first, second] = events().filter((line) => line.startsWith("start")).map((line) => line.split(" ")[1]);
      assert.deepStrictEqual(events(), [`start ${first}`, `start ${second}`, `end ${second}`],
        "the orphaned command is stopped before its wake is retried, so the schedule never overlaps itself");
    } finally {
      daemon.kill("SIGKILL");
      await scheduler.stop();
      state.close();
    }
  });

  assert.deepStrictEqual(failures, [], "every scenario passes");
  process.stdout.write("ok — run-finished wakes survive stop and SIGKILL, never wait on other schedules, round-robin across callers, skip same-ms history, and match origins as delegate does\n");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
