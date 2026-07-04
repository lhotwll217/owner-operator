// End-to-end test of the daemon: state endpoints, done-persist through the daemon's own
// reconcile, SSE push, client discovery, schedules (validation, run-now, bookkeeping), and
// the needs-you event trigger. Fake scan seam, ephemeral port, no model.
//   npm run test:daemon    (from harness/)

import assert from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DaemonEvent, DaemonInfo, ScanRow } from "@owner-operator/core";
import { fakeScanRow, tempOoHome, waitFor } from "../test/helpers";

const { dir, cleanup } = tempOoHome("oo-daemon");

try {
  const { startDaemon, isDue } = await import("./daemon");
  const { connectDaemon } = await import("./client");

  // --- isDue: the pure calendar math ---
  const NOW = new Date("2026-06-09T08:30:00");
  assert.equal(isDue({ type: "interval", ms: 60_000 }, undefined, NOW), true, "never-run interval is due");
  assert.equal(isDue({ type: "interval", ms: 60_000 }, new Date(NOW.getTime() - 30_000).toISOString(), NOW), false, "inside the interval → not due");
  assert.equal(isDue({ type: "interval", ms: 60_000 }, new Date(NOW.getTime() - 61_000).toISOString(), NOW), true, "past the interval → due");
  assert.equal(isDue({ type: "daily", at: "08:00" }, undefined, NOW), true, "daily past its local fire time is due");
  assert.equal(isDue({ type: "daily", at: "09:00" }, undefined, NOW), false, "daily before its fire time is not");
  assert.equal(isDue({ type: "daily", at: "08:00" }, NOW.toISOString(), NOW), false, "already ran after today's fire time");
  assert.equal(isDue({ type: "event", event: "needs-you" }, undefined, NOW), false, "event schedules are edge-driven, never tick-due");

  // --- no daemon yet → discovery says so ---
  assert.equal(await connectDaemon(), null, "no daemon.json → no daemon");

  let rows: ScanRow[] = [fakeScanRow()];
  const d = await startDaemon({ port: 0, poller: { scan: async () => rows }, watch: false, tickMs: 60_000 });
  const base = `http://127.0.0.1:${d.port}`;
  const get = async (path: string) => { const r = await fetch(base + path); return { status: r.status, body: await r.json() }; };
  const send = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
    return { status: r.status, body: await r.json() };
  };

  // --- state endpoints + discovery ---
  await send("POST", "/poll");
  assert.equal((await get("/snapshot")).body.threads[0].state, "needs-you");
  assert.equal((await get("/health")).body.ok, true);
  const info = JSON.parse(readFileSync(join(dir, "daemon.json"), "utf8")) as DaemonInfo;
  assert.equal(info.port, d.port, "daemon.json carries the live port");

  const backend = await connectDaemon();
  assert.equal(backend?.kind, "daemon", "client discovers the daemon");

  // --- SSE push: mark done lands immediately, and survives the daemon's own reconcile ---
  const events: DaemonEvent[] = [];
  const unsub = backend!.subscribe!((e) => events.push(e));
  await new Promise((r) => setTimeout(r, 200)); // let the stream attach
  const done = await backend!.markThreadsDone(["abc-123"]);
  assert.equal(done.marked[0].state, "done");
  await waitFor(
    () => events.some((e) => e.type === "snapshot" && e.snapshot.threads[0]?.state === "done"),
    3_000, "done snapshot push",
  );
  await send("POST", "/poll"); // unchanged scan — resolver holds the done
  assert.equal((await get("/snapshot")).body.threads[0].state, "done", "done survives the daemon reconcile");

  // --- schedules: validation, upsert, run-now + bookkeeping ---
  assert.equal((await send("PUT", "/schedules/bad", { when: { type: "interval", ms: 10 }, action: { type: "poll" } })).status, 400, "sub-5s interval rejected");
  const ranFile = join(dir, "ran.txt");
  const put = await send("PUT", "/schedules/touch", {
    when: { type: "interval", ms: 60_000 },
    action: { type: "shell", command: `node -e "require('fs').writeFileSync('${ranFile}', 'x')"` },
  });
  assert.equal(put.status, 200);
  assert.equal((await send("POST", "/schedules/touch/run")).body.ok, true);
  assert.ok(existsSync(ranFile), "run-now executed the shell action");
  const sched = (await get("/schedules")).body.find((s: { name: string }) => s.name === "touch");
  assert.ok(sched.lastRunAt, "run recorded");
  assert.equal(sched.lastResult.ok, true);

  // --- event trigger: a thread newly needing the owner fires the schedule with ids ---
  const needsFile = join(dir, "needs.txt");
  await send("PUT", "/schedules/notify", {
    when: { type: "event", event: "needs-you" },
    action: { type: "shell", command: `node -e "require('fs').writeFileSync('${needsFile}', process.env.OO_NEEDS_YOU || '')"` },
  });
  rows = [{ ...rows[0], lastMessageAt: "2026-06-09T10:07:00.000Z" }]; // newer message wakes the done thread
  await send("POST", "/poll");
  await waitFor(() => existsSync(needsFile), 4_000, "needs-you trigger");
  assert.equal(readFileSync(needsFile, "utf8"), "abc-123", "trigger received the thread ids");

  // --- triage roundtrip + push ---
  await send("POST", "/triage", { entries: { "abc-123": { topic: "Daemon wiring", priority: 5 } } });
  assert.equal((await get("/triage")).body["abc-123"].topic, "Daemon wiring");
  await waitFor(() => events.some((e) => e.type === "triage"), 2_000, "triage push");

  // --- owner rename: pinned through the daemon's own reconcile; empty clears it ---
  assert.equal((await send("POST", "/rename", { id: "abc-123" })).status, 400, "title required");
  assert.equal((await send("POST", "/rename", { id: "nope", title: "x" })).status, 404, "unknown thread → 404");
  assert.equal((await send("POST", "/rename", { id: "abc-123", title: "  Billing hotfix  " })).body.ok, true);
  await send("POST", "/poll"); // the rename is owner state — a reconcile pass can't clear it
  assert.equal((await get("/snapshot")).body.threads[0].ownerTitle, "Billing hotfix", "rename survives the reconcile (trimmed)");
  await send("POST", "/triage", { entries: { "abc-123": { topic: "Model retitle" } } });
  assert.equal((await get("/triage")).body["abc-123"].topic, "Daemon wiring", "the model can no longer retitle a renamed thread");
  await send("POST", "/rename", { id: "abc-123", title: "" });
  await send("POST", "/poll");
  assert.equal((await get("/snapshot")).body.threads[0].ownerTitle, undefined, "empty title clears — model titles resume");

  // --- schedule delete + shutdown cleanup ---
  assert.equal((await send("DELETE", "/schedules/touch")).status, 200);
  assert.equal((await send("DELETE", "/schedules/touch")).status, 404, "second delete → 404");

  unsub();
  backend!.close();
  await d.close();
  assert.ok(!existsSync(join(dir, "daemon.json")), "discovery file removed on close");

  process.stdout.write("ok — daemon owns state end to end\n");
} finally {
  cleanup();
}
