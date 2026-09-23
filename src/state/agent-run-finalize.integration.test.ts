// Integration: a run's terminal status and its terminal log record commit together. If the result
// record cannot be written, finish, restart interruption, and the lost sweep all leave the run
// running with no result, and succeed once the write can.
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AgentRunHarness, AgentRunStatus } from "@owner-operator/core";
import { ThreadDb } from "./database";
import { State } from "./state";

const dir = mkdtempSync(join(tmpdir(), "oo-finalize-"));
const path = join(dir, "state.db");
try {
  const db = new ThreadDb(path);
  for (const id of ["finish", "interrupt", "lost"]) {
    db.createAgentRun({ id, harness: AgentRunHarness.ClaudeCode, task: "t", cwd: "/tmp", depth: 1, timeoutSeconds: 60 });
    db.claimNextPendingAgentRun(3);
  }
  const other = new DatabaseSync(path);
  other.exec(`CREATE TRIGGER fail_result BEFORE INSERT ON agent_run_events
    WHEN json_extract(NEW.record, '$.type') = 'result' BEGIN SELECT RAISE(ABORT, 'result write failed'); END`);
  const unchanged = (id: string) => {
    assert.equal(db.agentRunById(id)!.status, AgentRunStatus.Running, `${id} stays running`);
    assert.deepEqual(db.agentRunEvents(id), [], `${id} has no result record`);
  };

  assert.throws(() => db.finishAgentRun("finish", { status: AgentRunStatus.Completed, resultTail: "x", error: null }), /result write failed/);
  unchanged("finish");
  assert.throws(() => db.markAgentRunsLost(["finish", "interrupt"], "9999-01-01T00:00:00.000Z"), /result write failed/);
  unchanged("lost");
  assert.throws(() => db.markRunningAgentRunsInterrupted("daemon restarted"), /result write failed/);
  for (const id of ["finish", "interrupt", "lost"]) unchanged(id);

  other.exec("DROP TRIGGER fail_result");
  db.finishAgentRun("finish", { status: AgentRunStatus.Completed, resultTail: "x", error: null });
  db.markAgentRunsLost(["interrupt"], "9999-01-01T00:00:00.000Z");
  db.markRunningAgentRunsInterrupted("daemon restarted");
  for (const [id, status] of [["finish", "completed"], ["lost", "lost"], ["interrupt", "interrupted"]] as const) {
    assert.equal(db.agentRunById(id)!.status, status);
    assert.deepEqual(db.agentRunEvents(id).map(({ record }) => [record.type, (record as { status?: string }).status]), [["result", status]],
      `${id} finalizes with exactly one result record`);
  }
  other.close();
  db.close();
  // A lost sweep that fails part way still announces the runs it already finalized, so a follower
  // of an earlier run receives its terminal record.
  const statePath = join(dir, "sweep.db");
  const state = new State(statePath);
  const ids = ["first", "second"].map((task) => {
    const run = state.createAgentRun({ harness: AgentRunHarness.ClaudeCode, task, cwd: "/tmp", depth: 1, timeoutSeconds: 60 });
    state.claimNextPendingAgentRun(3);
    return run.id;
  });
  const sweepOther = new DatabaseSync(statePath);
  sweepOther.exec(`CREATE TRIGGER fail_second BEFORE INSERT ON agent_run_events
    WHEN json_extract(NEW.record, '$.runId') = '${ids[1]}' BEGIN SELECT RAISE(ABORT, 'second result failed'); END`);
  const woken: string[] = [];
  state.subscribeAgentRunLog((runId) => woken.push(runId));
  assert.throws(() => state.markAgentRunsLost([], "9999-01-01T00:00:00.000Z"), /second result failed/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.agentRunById(ids[0]!)!.status, AgentRunStatus.Lost, "the first run was finalized");
  assert.deepEqual(woken, [ids[0]], "its log follower is woken even though the sweep failed later");
  assert.equal(state.agentRunById(ids[1]!)!.status, AgentRunStatus.Running, "the failed run stays running for the next sweep");
  sweepOther.close();
  state.close();
} finally {
  rmSync(dir, { recursive: true, force: true });
}

process.stdout.write("ok — run finalization and its terminal record are atomic on every finalization path\n");
