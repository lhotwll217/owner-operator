// Integration: a turn keeps running when the ledger cannot record its activity (issue #228).
//
// On 2026-11-23 the disk filled while three orchestrators were mid-turn. Recording a stream event
// threw SQLITE_FULL inside the launcher's event loop, which ended each live turn; the failed
// finalize then left the rows running until the lost sweep reported them as dead. The child's
// work outranks the ledger's bookkeeping about it.
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentRunHarness,
  AgentRunStatus,
  approveDelegatedBaseline,
  type AgentRunLaunchRequest,
  type AgentRunLaunchResult,
} from "@owner-operator/core";
import { InMemoryEventBus } from "../state/event-bus";
import { State } from "../state/state";
import { AgentRunExecutor } from "./executor";

const dir = mkdtempSync(join(tmpdir(), "oo-activity-write-failure-"));
const previousOoHome = process.env.OO_HOME;
process.env.OO_HOME = dir;
approveDelegatedBaseline(AgentRunHarness.ClaudeCode, { model: "test-claude", effort: null }, dir);

let closeState: (() => void) | undefined;
try {
  const state = new State(join(dir, "state.db"), { bus: new InMemoryEventBus() });
  closeState = () => state.close();

  let diskFull = false;
  const full = () => { throw new Error("database or disk is full"); };
  const recordActivity = state.recordAgentRunActivity.bind(state);
  const appendEvent = state.appendAgentRunEvent.bind(state);
  state.recordAgentRunActivity = (...args) => diskFull ? full() : recordActivity(...args);
  state.appendAgentRunEvent = (...args) => diskFull ? full() : appendEvent(...args);

  let midTurn!: () => void;
  const reachedMidTurn = new Promise<void>((resolve) => { midTurn = resolve; });
  let resumeTurn!: () => void;
  const turnResumes = new Promise<void>((resolve) => { resumeTurn = resolve; });
  const launcher = async (request: AgentRunLaunchRequest): Promise<AgentRunLaunchResult> => {
    request.onActivity({ activity: "running sleep 10", childSessionId: "orchestrator-child" });
    midTurn();
    await turnResumes;
    request.onEvent?.({ type: "tool_call", title: "sleep 10", text: "sleep 10" });
    request.onActivity({ activity: "sleep 10 returned" });
    return { status: AgentRunStatus.Completed, resultText: "PROBE_DONE", error: null };
  };
  const logged: unknown[] = [];
  const executor = new AgentRunExecutor(state, { launcher, tickMs: 10, lostGraceMs: 60_000, logger: (record) => logged.push(record) });
  executor.start();

  const run = executor.launch({ harness: AgentRunHarness.ClaudeCode, task: "orchestrate the release", cwd: dir });
  await reachedMidTurn;
  diskFull = true;
  resumeTurn();
  await new Promise((resolve) => setTimeout(resolve, 20));
  diskFull = false;

  const finished = await executor.wait(run.id, 5_000);
  assert.equal(finished.status, AgentRunStatus.Completed, `a failed activity write does not end the turn: ${finished.error}`);
  assert.equal(finished.resultTail, "PROBE_DONE", "the turn's result is recorded once the ledger can write again");
  assert.ok(
    logged.some((record) => JSON.stringify(record).includes("database or disk is full")),
    "the dropped activity write is logged",
  );
  await executor.stop();
  process.stdout.write("ok - a turn outlives a failed activity write\n");
} finally {
  closeState?.();
  if (previousOoHome === undefined) delete process.env.OO_HOME;
  else process.env.OO_HOME = previousOoHome;
  rmSync(dir, { recursive: true, force: true });
}
