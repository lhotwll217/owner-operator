// Deterministic test of the sidebar data model — pure, no model, no I/O.
// The sidebar = the LIVE poll snapshot enriched by the triage cache, joined by id, minus
// threads whose status is `done` — with display-order numbering as the /done handle.

import assert from "node:assert";
import { toSidebarThreads, groupByRepo, numberThreads, parseNumbers, stateCounts, displayTopic, type TriageInfo } from "./sidebar";
import type { StatusSnapshot, ThreadStatus } from "./status";

const NOW = "2026-06-09T12:00:00.000Z";

const st = (id: string, repo: string, state: ThreadStatus["state"], topic: string, createdAt = NOW): ThreadStatus => ({
  id, source: "claude", repo, app: "Claude CLI", topic, state, lastActive: "1m",
  createdAt, lastMessageAt: NOW, firstSeen: NOW, stateSince: NOW,
});

// Poll snapshot drives membership — including an old/idle thread that must NOT be filtered out.
const snap: StatusSnapshot = {
  polledAt: NOW,
  threads: [
    st("n", "billing", "needs-you", "raw 422 topic"),
    st("o", "owner-operator", "working", "raw sidebar topic"),
    st("old", "billing", "idle", "raw roadmap topic", "2026-06-01T00:00:00.000Z"),
    st("d", "billing", "done", "raw done topic"),
  ],
};
// Triage enriches only some (by id); untriaged threads still appear with their raw topic.
const triage = new Map<string, TriageInfo>([
  ["n", { topic: "422 contract mismatch", nextSteps: "Paste the drafted reply", priority: 5 }],
]);

const sidebar = toSidebarThreads(snap, triage);

// --- the sidebar projection includes the snapshot; done rows are inactive and unnumbered later ---
assert.equal(sidebar.length, 4, "every polled thread appears in the projection");
assert.deepEqual(sidebar.map((t) => t.id).sort(), ["d", "n", "o", "old"]);
assert.equal(sidebar.find((t) => t.id === "d")!.active, false, "done status → inactive");

// --- triaged thread is enriched; untriaged keeps its raw topic + no badge ---
const n = sidebar.find((t) => t.id === "n")!;
assert.equal(displayTopic(n), "422 contract mismatch", "triaged title wins");
assert.equal(n.nextSteps, "Paste the drafted reply");
assert.equal(n.priority, 5);
assert.equal(n.state, "needs-you", "live state from the poll");
const o = sidebar.find((t) => t.id === "o")!;
assert.equal(displayTopic(o), "raw sidebar topic", "untriaged → raw digest topic");
assert.equal(o.priority, undefined, "untriaged → no priority badge");

// --- grouping + stats over the live set ---
assert.deepEqual(groupByRepo(sidebar).map((g) => g.repo), ["billing", "owner-operator"], "needs-you group first");
assert.deepEqual(stateCounts(sidebar), { "needs-you": 1, working: 1, idle: 1, done: 1 });

// --- numbering: ACTIVE rows only, 1…n in display order — the /done handle ---
const { groups, byNum } = numberThreads(sidebar);
assert.equal(byNum.size, 3, "done rows are not numbered (they left the sidebar)");
assert.deepEqual([...byNum.keys()], [1, 2, 3], "numbers are 1…n");
assert.deepEqual(groups.flatMap((g) => g.threads).map((t) => t.num), [1, 2, 3], "rendered order carries the same numbers");
assert.equal(byNum.get(1)!.id, "n", "display order: needs-you first");
assert.equal(byNum.get(2)!.id, "old", "same repo stays grouped");
assert.equal(byNum.get(3)!.id, "o", "next repo follows");
assert.ok(!sidebar.some((t) => t.num !== undefined), "numbering is pure — inputs untouched");

// --- /done argument parsing ---
assert.deepEqual(parseNumbers("1,3,5"), [1, 3, 5]);
assert.deepEqual(parseNumbers(" 2, 2  4"), [2, 4], "dedupes, tolerates spaces");
assert.deepEqual(parseNumbers("nope"), [], "no numbers → empty");

process.stdout.write("ok — sidebar data model passed\n");
