// Integration: GET /agent-runs/:id/events is a bounded, drain-aware pump. A client that stops
// reading stops the log from being read out of SQLite; resuming delivers every record. A result is
// synthesized only for a run that never had a log, never after a consumed terminal record.
import assert from "node:assert/strict";
import net from "node:net";
import { join } from "node:path";
import { AgentRunStatus, type AgentRun, type AgentRunLogRecord } from "@owner-operator/core";
import { State } from "../state/state";
import { startGateway } from "./server";
import { tempOoHome, waitFor } from "./test/helpers";

const { dir, cleanup } = tempOoHome("oo-run-log-stream");
const TOTAL = 3_000;
const text = "z".repeat(8_000);
let read = 0;
const runs: Record<string, Partial<AgentRun> & { lastSeq: number | null; log: number }> = {
  big: { id: "big", status: AgentRunStatus.Completed, lastSeq: TOTAL + 1, log: TOTAL },
  done: { id: "done", status: AgentRunStatus.Completed, lastSeq: 2, log: 1 },
  legacy: { id: "legacy", status: AgentRunStatus.Failed, error: "old failure", lastSeq: null, log: 0 },
};
function* events(id: string, after: number): Generator<{ seq: number; record: AgentRunLogRecord }> {
  const run = runs[id]!;
  for (let seq = after + 1; seq <= run.log + (run.lastSeq === null ? 0 : 1); seq++) {
    read += 1;
    yield seq <= run.log
      ? { seq, record: { type: "text_delta", text } }
      : { seq, record: { type: "result", runId: id, status: run.status! } };
  }
}
const state = new State(join(dir, "state.db"));
const gateway = await startGateway({
  authToken: "t", state, port: 0,
  health: () => ({ ok: true, port: 0, pid: process.pid, startedAt: "now", fingerprint: "f", stale: false }),
  ready: () => ({ ready: true, setupRequired: false, modules: { state: true, sessionMonitor: true, scheduler: true, gateway: true } }),
  agentRuns: {
    get: (id: string) => runs[id] as AgentRun | undefined,
    events,
    lastSeq: (id: string) => runs[id]?.lastSeq ?? null,
    subscribeLog: () => () => undefined,
  } as never,
  monitor: {} as never, scheduler: {} as never, worktrees: {} as never, query: {} as never, harness: {} as never, search: {} as never,
});
const dataLines = async (path: string): Promise<string[]> => {
  const response = await fetch(`http://127.0.0.1:${gateway.port}${path}`, { headers: { authorization: "Bearer t" } });
  return (await response.text()).split("\n").filter((line) => line.startsWith("data: "));
};

try {
  // A stalled reader: the pump stops reading rows once the socket pushes back.
  const socket = net.connect(gateway.port, "127.0.0.1");
  await new Promise((resolve) => socket.once("connect", resolve));
  socket.pause();
  socket.write("GET /agent-runs/big/events HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer t\r\n\r\n");
  await new Promise((resolve) => setTimeout(resolve, 500));
  const readWhileStalled = read;
  assert.ok(readWhileStalled < TOTAL / 2, `a stalled client stops the reads (${readWhileStalled} of ${TOTAL + 1})`);
  let received = "";
  socket.setEncoding("utf8").on("data", (chunk) => { received += chunk; });
  socket.resume();
  await waitFor(() => received.includes('"type":"result"'), 10_000, "resumed client reaches the terminal record");
  socket.destroy();
  assert.equal(received.split("\n").filter((line) => line.startsWith("data: ")).length, TOTAL + 1, "every record arrives after resuming");

  // Synthesis is for runs that never had a log.
  assert.deepEqual(await dataLines("/agent-runs/done/events?after=2"), [], "a consumed terminal cursor gets no duplicate result");
  assert.equal((await dataLines("/agent-runs/done/events")).at(-1), 'data: {"type":"result","runId":"done","status":"completed"}');
  assert.deepEqual(await dataLines("/agent-runs/legacy/events"), [
    'data: {"type":"result","runId":"legacy","status":"failed","error":{"message":"old failure"}}',
  ], "a run finalized before event logs existed still gets its result");
} finally {
  await gateway.close();
  state.close();
  cleanup();
}

process.stdout.write("ok — run-log SSE: backpressure stops reads, resume delivers all, synthesis only for legacy runs\n");
