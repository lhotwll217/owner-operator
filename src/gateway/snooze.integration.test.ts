import assert from "node:assert/strict";
import { join } from "node:path";
import { GatewayEventKind, type SessionStateRow } from "@owner-operator/core";
import { State } from "../state/state";
import { startGateway } from "./server";
import { fakeScanRow, tempOoHome, waitFor } from "./test/helpers";

const { dir, cleanup } = tempOoHome("oo-snooze-gateway");
const state = new State(join(dir, "state.db"), { now: () => "2026-06-09T10:10:00.000Z", activeWindow: "1d" });
state.recordObservation(fakeScanRow({ id: "thread-1" }));
const gateway = await startGateway({
  authToken: "token",
  state,
  monitor: { poll: async () => undefined },
  scheduler: {} as never, agentRuns: {} as never, worktrees: {} as never,
  query: {} as never, harness: {} as never, search: {} as never,
  health: () => ({ ok: true, port: 0, pid: process.pid, startedAt: "now", fingerprint: "snooze", stale: false, repoRoot: "/test" }),
  ready: () => ({ ready: true, setupRequired: false, modules: { state: true, sessionMonitor: true, scheduler: true, gateway: true } }),
  port: 0,
});
const base = `http://127.0.0.1:${gateway.port}`;
const headers = { authorization: "Bearer token", "content-type": "application/json" };
const snooze = (body: unknown) => fetch(`${base}/snooze`, { method: "POST", headers, body: JSON.stringify(body) });
const sessionState = async () => await (await fetch(`${base}/session-state`, { headers })).json() as SessionStateRow[];

try {
  const frames: string[] = [];
  const events = new AbortController();
  const stream = await fetch(`${base}/events`, { headers, signal: events.signal });
  void (async () => {
    const decoder = new TextDecoder();
    try {
      for await (const chunk of stream.body!) frames.push(decoder.decode(chunk));
    } catch { /* aborted at teardown */ }
  })();
  await waitFor(() => frames.some((frame) => frame.includes(":ready")), 1_000, "SSE ready");

  for (const body of [
    {}, { id: "thread-1" }, { id: 7, snooze: null }, { id: "thread-1", snooze: { kind: "later" } },
    { id: "thread-1", snooze: { kind: "until" } }, { id: "thread-1", snooze: { kind: "until", until: "soon" } },
    { id: "thread-1", snooze: { kind: "until", until: "2026-06-09T10:00:00.000Z" } },
  ]) {
    assert.equal((await snooze(body)).status, 400, `rejects ${JSON.stringify(body)}`);
  }
  assert.equal((await snooze({ id: "missing", snooze: { kind: "next-message" } })).status, 404);

  const response = await snooze({ id: "thread-1", snooze: { kind: "until", until: "2026-06-09T18:00:00.000Z" } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  const [row] = await sessionState();
  assert.deepEqual({ section: row?.section, snooze: row?.snooze }, {
    section: "snoozed", snooze: { kind: "until", until: "2026-06-09T18:00:00.000Z" },
  }, "the projection reports the held snooze");
  await waitFor(
    () => frames.some((frame) => frame.includes(JSON.stringify({ kind: GatewayEventKind.StateChanged }))),
    1_000,
    "state.changed after a snooze",
  );

  assert.equal((await snooze({ id: "thread-1", snooze: null })).status, 200);
  assert.deepEqual((await sessionState())[0]?.snooze, null, "a null snooze wakes the row");
  events.abort();
  console.log("ok - POST /snooze validates its body, 404s an unknown id, applies, and invalidates over SSE");
} finally {
  await gateway.close();
  state.close();
  cleanup();
}
