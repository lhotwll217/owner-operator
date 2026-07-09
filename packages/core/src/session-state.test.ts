// Deterministic test of the session-state data model — pure, no model, no I/O.
// Session state = the LIVE poll snapshot enriched by the cached model details, joined by id,
// minus threads whose status is `done` — with stable display-order numbering.

import assert from "node:assert";
import { toSessionStateThreads, groupSessionStateByRepo, numberSessionStateRows, displayTitle, type ThreadDetails } from "./session-state";
import type { ThreadStatus } from "./status";

const NOW = "2026-06-09T12:00:00.000Z";

const st = (id: string, repo: string, state: ThreadStatus["state"], topic: string, createdAt = NOW): ThreadStatus => ({
  id, source: "claude", repo, app: "Claude CLI", topic, state, lastActive: "1m",
  createdAt, lastMessageAt: NOW, firstSeen: NOW,
});

// Poll snapshot drives membership — including an old/idle thread that must NOT be filtered out.
const threads: ThreadStatus[] = [
    st("n", "billing", "needs-you", "raw 422 topic"),
    st("o", "owner-operator", "working", "raw session topic"),
    st("old", "billing", "idle", "raw roadmap topic", "2026-06-01T00:00:00.000Z"),
    st("d", "billing", "done", "raw done topic"),
];
// Model details enrich only some (by id); un-enriched threads still appear with their raw topic.
const details = new Map<string, ThreadDetails>([
  ["n", { topic: "422 contract mismatch", nextSteps: "Paste the drafted reply", priority: 5 }],
]);

const rows = toSessionStateThreads(threads, details);

// --- the session-state projection includes the snapshot; done rows are inactive and unnumbered later ---
assert.equal(rows.length, 4, "every polled thread appears in the projection");
assert.deepEqual(rows.map((t) => t.id).sort(), ["d", "n", "o", "old"]);
assert.equal(rows.find((t) => t.id === "d")!.active, false, "done status → inactive");

// --- enriched thread shows the generated title; un-enriched keeps its raw topic + no badge ---
const n = rows.find((t) => t.id === "n")!;
assert.equal(displayTitle(n), "422 contract mismatch", "generated title wins");
assert.equal(n.nextSteps, "Paste the drafted reply");
assert.equal(n.priority, 5);
assert.equal(n.state, "needs-you", "live state from the poll");
const o = rows.find((t) => t.id === "o")!;
assert.equal(displayTitle(o), "raw session topic", "un-enriched → raw digest topic");
assert.equal(o.priority, undefined, "un-enriched → no priority badge");

// --- an owner rename outranks both the generated title and the raw topic ---
const renamed = toSessionStateThreads(
  [{ ...st("r", "billing", "idle", "raw topic"), ownerTitle: "Owner's name" }],
  new Map([["r", { topic: "Model title" }]]),
)[0];
assert.equal(displayTitle(renamed), "Owner's name", "owner rename wins over the generated title");

// --- grouping over the live set ---
assert.deepEqual(groupSessionStateByRepo(rows).map((g) => g.repo), ["billing", "owner-operator"], "needs-you group first");

// --- numbering: ACTIVE rows only, 1…n in display order ---
const { groups, byNum } = numberSessionStateRows(rows);
assert.equal(byNum.size, 3, "done rows are not numbered (they left session state)");
assert.deepEqual([...byNum.keys()], [1, 2, 3], "numbers are 1…n");
assert.deepEqual(groups.flatMap((g) => g.threads).map((t) => t.num), [1, 2, 3], "rendered order carries the same numbers");
assert.equal(byNum.get(1)!.id, "n", "display order: needs-you first");
assert.equal(byNum.get(2)!.id, "old", "same repo stays grouped");
assert.equal(byNum.get(3)!.id, "o", "next repo follows");
assert.ok(!rows.some((t) => t.num !== undefined), "numbering is pure — inputs untouched");

process.stdout.write("ok — session-state data model passed\n");
