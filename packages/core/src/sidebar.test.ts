// Deterministic test of the sidebar data model — pure, no model, no I/O.
// The rail = the LIVE poll snapshot (no filtering) enriched by the triage cache, joined by id.

import assert from "node:assert";
import { toSidebarThreads, groupByRepo, stateCounts, displayTopic, type TriageInfo } from "./sidebar";
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

process.stdout.write("ok — sidebar data model passed\n");
