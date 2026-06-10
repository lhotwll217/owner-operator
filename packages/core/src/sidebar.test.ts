// Deterministic test of the sidebar data model — pure, no model, no I/O.
// The rail = the LIVE poll snapshot (no filtering) enriched by the triage cache, joined by id,
// minus the done overlay (/done) — with display-order numbering as the /done handle.

import assert from "node:assert";
import { toSidebarThreads, groupByRepo, numberThreads, parseNumbers, stateCounts, displayTopic, type TriageInfo } from "./sidebar";
import type { StatusSnapshot, ThreadStatus } from "./status";

const NOW = "2026-06-09T12:00:00.000Z";

const st = (id: string, repo: string, state: ThreadStatus["state"], topic: string, createdAt = NOW): ThreadStatus => ({
  id, source: "claude", repo, app: "Claude Code", topic, state, lastActive: "1m",
  createdAt, lastMessageAt: NOW, firstSeen: NOW, stateSince: NOW,
});

// Poll snapshot drives membership — including an old/idle thread that must NOT be filtered out.
const snap: StatusSnapshot = {
  polledAt: NOW,
  threads: [
    st("n", "amplify", "needs-you", "raw 422 topic"),
    st("o", "owner-operator", "working", "raw sidebar topic"),
    st("old", "amplify", "idle", "raw roadmap topic", "2026-06-01T00:00:00.000Z"),
  ],
};
// Triage enriches only some (by id); untriaged threads still appear with their raw topic.
const triage = new Map<string, TriageInfo>([
  ["n", { topic: "422 contract mismatch", nextSteps: "Paste the drafted reply", priority: 5 }],
]);

const rail = toSidebarThreads(snap, triage);

// --- the rail = ALL polled threads, no filtering (the idle/old one stays) ---
assert.equal(rail.length, 3, "every polled thread appears — nothing filtered");
assert.deepEqual(rail.map((t) => t.id).sort(), ["n", "o", "old"]);
assert.ok(rail.every((t) => t.active), "no done overlay → everything active");

// --- triaged thread is enriched; untriaged keeps its raw topic + no badge ---
const n = rail.find((t) => t.id === "n")!;
assert.equal(displayTopic(n), "422 contract mismatch", "triaged title wins");
assert.equal(n.nextSteps, "Paste the drafted reply");
assert.equal(n.priority, 5);
assert.equal(n.state, "needs-you", "live state from the poll");
const o = rail.find((t) => t.id === "o")!;
assert.equal(displayTopic(o), "raw sidebar topic", "untriaged → raw digest topic");
assert.equal(o.priority, undefined, "untriaged → no priority badge");

// --- grouping + stats over the live set ---
assert.deepEqual(groupByRepo(rail).map((g) => g.repo), ["amplify", "owner-operator"], "needs-you group first");
assert.deepEqual(stateCounts(rail), { "needs-you": 1, working: 1, idle: 1, done: 0 });

// --- the done overlay: marked rows go inactive (state done); new activity reactivates ---
const done = new Map([
  ["n", "2026-06-09T13:00:00.000Z"],   // marked AFTER its last message → inactive
  ["o", "2026-06-09T11:00:00.000Z"],   // a message landed AFTER the mark → active again
]);
const overlaid = toSidebarThreads(snap, triage, done);
const dn = overlaid.find((t) => t.id === "n")!;
assert.equal(dn.active, false, "marked done after last activity → inactive");
assert.equal(dn.state, "done", "inactive rows read as done");
assert.equal(overlaid.find((t) => t.id === "o")!.active, true, "new activity after the mark wakes the thread");
assert.deepEqual(stateCounts(overlaid), { "needs-you": 0, working: 1, idle: 1, done: 1 });

// --- numbering: ACTIVE rows only, 1…n in display order — the /done handle ---
const { groups, byNum } = numberThreads(overlaid);
assert.equal(byNum.size, 2, "done rows are not numbered (they left the rail)");
assert.deepEqual([...byNum.keys()], [1, 2], "numbers are 1…n");
assert.deepEqual(groups.flatMap((g) => g.threads).map((t) => t.num), [1, 2], "rendered order carries the same numbers");
assert.equal(byNum.get(1)!.id, "o", "display order: loudest group first (working beats idle)");
assert.equal(byNum.get(2)!.id, "old");
assert.ok(!rail.some((t) => t.num !== undefined), "numbering is pure — inputs untouched");

// --- /done argument parsing ---
assert.deepEqual(parseNumbers("1,3,5"), [1, 3, 5]);
assert.deepEqual(parseNumbers(" 2, 2  4"), [2, 4], "dedupes, tolerates spaces");
assert.deepEqual(parseNumbers("nope"), [], "no numbers → empty");

process.stdout.write("ok — sidebar data model passed\n");
