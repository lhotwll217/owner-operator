import assert from "node:assert/strict";
import { join } from "node:path";
import { State } from "../state/state";
import { SessionMonitor } from "../session-monitor/monitor";
import { startGateway } from "./server";
import { fakeScanRow, tempOoHome, waitFor } from "./test/helpers";

const { dir, cleanup } = tempOoHome("oo-gateway-reconciliation");
const state = new State(join(dir, "state.db"), { now: () => "2026-06-09T12:00:00.000Z" });
const row = fakeScanRow({ secondsSinceLastMessage: 4000 });
state.recordObservation(row);
state.appendEnrichment(row.id, { topic: "Thread cleanup", summary: "Review the cleanup", priority: 2, attention: "needs-you" as const }, row.lastMessageAt);
const monitor = new SessionMonitor(state, {
  scan: async () => [row],
  enrich: async () => ({ topic: "Thread cleanup", attention: "idle", summary: "The requested cleanup completed without an outstanding question.", priority: 2 }),
});
const gateway = await startGateway({
  authToken: "test-token", state, monitor, port: 0,
  health: () => ({ ok: true, port: 0, pid: process.pid, startedAt: "now", fingerprint: "test", stale: false }),
  ready: () => ({ ready: true, setupRequired: false, modules: { state: true, sessionMonitor: true, scheduler: true, gateway: true } }),
  scheduler: {} as never, agentRuns: {} as never, worktrees: {} as never, query: {} as never,
});
const endpoint = `http://127.0.0.1:${gateway.port}`;
async function post(body: unknown, token = "test-token") {
  return fetch(`${endpoint}/poll`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
}
try {
  assert.equal((await post({}, "wrong-token")).status, 401);
  assert.equal((await post({ reconcile: [{ id: row.id }] })).status, 400);
  const rejected = await post({ reconcile: [{ id: row.id, lastMessageAt: "2000-01-01T00:00:00.000Z" }] });
  assert.deepEqual(await rejected.json(), { ok: true, queuedIds: [] });
  assert.equal(state.listCurrentSessionState()[0]?.summary, "Review the cleanup");
  const accepted = await post({ reconcile: [{ id: row.id, lastMessageAt: row.lastMessageAt }] });
  assert.deepEqual(await accepted.json(), { ok: true, queuedIds: [row.id] });
  await waitFor(() => state.listSessionState()[0]?.summary === "The requested cleanup completed without an outstanding question.", 1000, "existing monitor recovery");
  const projection = await fetch(`${endpoint}/session-state`, { headers: { authorization: "Bearer test-token" } });
  const rows = await projection.json();
  assert.equal(rows.length, 1, "recovered completion remains in the widget until explicitly closed");
  assert.equal(rows[0].state, "idle");
  assert.equal(rows[0].summary, "The requested cleanup completed without an outstanding question.");
  state.markThreadsDone([row.id]);
  assert.deepEqual(await (await post({ reconcile: [{ id: row.id, lastMessageAt: row.lastMessageAt }] })).json(), { ok: true, queuedIds: [] });
  console.log("ok - guarded Gateway recovery uses the existing monitor and preserves done");
} finally {
  await gateway.close();
  monitor.stop();
  state.close();
  cleanup();
}
