// Deterministic test of the SQLite-backed store seam: the one-time legacy-JSON seed, the
// status.json export, triage versioning through the cache seam, and the write-boundary
// done-hold — a SECOND connection (≈ another process) saving a STALE snapshot must not
// clobber an operator-set done. This is the multi-consumer-writing guarantee.
//   npm run test:store     (from harness/)

import assert from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StatusSnapshot, ThreadStatus } from "@owner-operator/core";

const dir = mkdtempSync(join(tmpdir(), "oo-store-"));
process.env.OO_HOME = dir;

const thread = (over: Partial<ThreadStatus> = {}): ThreadStatus => ({
  id: "a", source: "claude", repo: "demo", app: "Claude CLI", topic: "ship it",
  state: "needs-you", lastActive: "just now",
  createdAt: "2026-06-09T10:00:00.000Z", lastMessageAt: "2026-06-09T10:05:00.000Z",
  firstSeen: "2026-06-09T10:01:00.000Z", stateSince: "2026-06-09T10:05:00.000Z",
  diffAdded: 19, diffDeleted: 5,
  ...over,
});

try {
  // Legacy JSON on disk BEFORE first store use → seeded into the db exactly once.
  const legacy: StatusSnapshot = { polledAt: "2026-06-09T10:06:00.000Z", threads: [thread()] };
  writeFileSync(join(dir, "status.json"), JSON.stringify(legacy));
  writeFileSync(join(dir, "triage.json"), JSON.stringify({ a: { topic: "Ship the fix", priority: 4 } }));

  const store = await import("./store");
  const { ThreadDb } = await import("./threads-db");

  const seeded = store.loadSnapshot();
  assert.equal(seeded?.polledAt, legacy.polledAt, "legacy snapshot seeded");
  assert.equal(seeded?.threads[0].state, "needs-you");
  assert.deepEqual([seeded?.threads[0].diffAdded, seeded?.threads[0].diffDeleted], [19, 5], "git delta survives the db round-trip");
  assert.equal(store.loadTriage().get("a")?.topic, "Ship the fix", "legacy triage seeded");

  // Operator marks done through the seam → db truth + refreshed export for cold readers.
  const marked = store.markThreadsDone(["a", "ghost"], { now: "2026-06-09T10:07:00.000Z" });
  assert.equal(marked.snapshot?.threads[0].state, "done");
  assert.equal(marked.marked[0].previousState, "needs-you");
  assert.deepEqual(marked.missingIds, ["ghost"]);
  const exported = JSON.parse(readFileSync(join(dir, "status.json"), "utf8")) as StatusSnapshot;
  assert.equal(exported.threads[0].state, "done", "status.json export refreshed after the mark");

  // THE multi-writer guarantee: a second connection saving a STALE snapshot — loaded
  // before the mark, same lastMessageAt — cannot clobber the done (write-boundary hold).
  const other = new ThreadDb();
  other.saveSnapshot({ polledAt: "2026-06-09T10:08:00.000Z", threads: [thread()] }); // still says needs-you
  assert.equal(store.loadSnapshot()?.threads[0].state, "done", "stale writer cannot resurrect a done thread");

  // A NEWER message wakes it — through any writer, no operator action needed.
  other.saveSnapshot({
    polledAt: "2026-06-09T10:09:00.000Z",
    threads: [thread({ lastMessageAt: "2026-06-09T10:09:00.000Z" })],
  });
  assert.equal(store.loadSnapshot()?.threads[0].state, "needs-you", "newer message wakes through the write boundary");

  // Triage cache seam: re-saving an unchanged map appends nothing; a change bumps the version.
  store.saveTriage(new Map([["a", { topic: "Ship the fix", priority: 4 }]]));
  assert.equal(other.getLatestTriage("a")?.version, 1, "unchanged entry stays version-stable");
  store.saveTriage(new Map([["a", { topic: "Ship the fix", priority: 5, nextSteps: "push it" }]]));
  assert.equal(other.getLatestTriage("a")?.version, 2, "changed entry appends a version");
  assert.equal(store.loadTriage().get("a")?.nextSteps, "push it");

  // Triage for a thread the poll hasn't seen yet: stub row, kept, but never in a snapshot.
  store.saveTriage(new Map([["zzz", { topic: "Future thread" }]]));
  assert.equal(store.loadTriage().get("zzz")?.topic, "Future thread", "pre-poll triage is not lost");
  assert.ok(!store.loadSnapshot()?.threads.some((t) => t.id === "zzz"), "stub rows stay out of the snapshot");

  other.close();
  process.stdout.write("ok — sqlite store seam passed\n");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
