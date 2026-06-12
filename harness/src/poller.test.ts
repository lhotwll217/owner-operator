// Regression test for owner-set status: mark done, then poll unchanged scan data.
// The poller must treat status.json as the source of truth, not stale in-memory current.

import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScanRow } from "@owner-operator/core";

const dir = mkdtempSync(join(tmpdir(), "oo-poller-"));
process.env.OO_HOME = dir;

try {
  const { StatusPoller } = await import("./poller");
  const { loadSnapshot, markThreadsDone } = await import("./store");

  let rows: ScanRow[] = [{
    id: "abc-123",
    source: "claude",
    repo: "owner-operator",
    app: "Claude CLI",
    topic: "mark done status",
    lastRole: "assistant",
    createdAt: "2026-06-09T10:00:00.000Z",
    lastMessageAt: "2026-06-09T10:05:00.000Z",
    secondsSinceLastMessage: 60,
    secondsSinceActivity: 60,
    working: false,
  }];

  const poller = new StatusPoller({ scan: async () => rows });
  const first = await poller.poll();
  assert.equal(first?.threads[0].state, "needs-you");

  const marked = markThreadsDone(["abc-123"], { now: "2026-06-09T10:06:00.000Z" });
  assert.equal(marked.marked[0].state, "done");
  assert.equal(loadSnapshot()?.threads[0].state, "done");

  const unchanged = await poller.poll();
  assert.equal(unchanged?.threads[0].state, "done", "poll preserves disk-sourced done state");

  // App refresh/reload: a brand-new poller (fresh process, no in-memory continuity) joins
  // the persisted store through the resolver — done must survive a cold rebuild too.
  const reloaded = new StatusPoller({ scan: async () => rows });
  const afterReload = await reloaded.poll();
  assert.equal(afterReload?.threads[0].state, "done", "fresh poller preserves persisted done");
  reloaded.stop();

  rows = [{ ...rows[0], lastMessageAt: "2026-06-09T10:07:00.000Z" }];
  const awakened = await poller.poll();
  assert.equal(awakened?.threads[0].state, "needs-you", "newer message wakes a done thread");

  poller.stop();
  process.stdout.write("ok — poller preserves owner-set done status\n");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
