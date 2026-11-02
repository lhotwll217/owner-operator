// Deterministic test of the session-state data model — pure, no model, no I/O.
// Session state = the LIVE poll snapshot enriched by the cached model details, joined by id,
// minus threads whose status is `done` — and the one display order every surface shares.

import assert from "node:assert";
import { toSessionStateThreads, arrangeSessionState, displayTitle, type SessionFacts, type ThreadDetails } from "./session-state";
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
  ["n", { topic: "422 contract mismatch", priority: 5, statusSummary: "Paste the drafted reply" }],
]);

const rows = toSessionStateThreads(threads, details);

// --- the session-state projection includes the snapshot; done rows are inactive and unnumbered later ---
assert.equal(rows.length, 4, "every polled thread appears in the projection");
assert.deepEqual(rows.map((t) => t.id).sort(), ["d", "n", "o", "old"]);
assert.equal(rows.find((t) => t.id === "d")!.active, false, "done status → inactive");

// --- enriched thread shows the generated title; un-enriched keeps its raw topic + no badge ---
const n = rows.find((t) => t.id === "n")!;
assert.equal(displayTitle(n), "422 contract mismatch", "generated title wins");
assert.equal(n.statusSummary, "Paste the drafted reply");
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

// --- arrangement: the one display order ---
const fact = (
  id: string,
  state: SessionFacts["state"],
  at: { created?: string | null; message?: string | null } = {},
  extra: Partial<SessionFacts> = {},
): SessionFacts => ({
  id, state, snooze: null, parentThreadId: null,
  createdAt: at.created === undefined ? "2026-06-09T09:00:00.000Z" : at.created,
  lastMessageAt: at.message === undefined ? "2026-06-09T09:00:00.000Z" : at.message,
  ...extra,
});
const order = (input: SessionFacts[]) => arrangeSessionState(input).map((r) => `${r.section}:${r.id}@${r.depth}`);

assert.deepEqual(order([
  fact("i", "idle"),
  fact("s", "needs-you", {}, { snooze: { kind: "next-message" } }),
  fact("w", "working"),
  fact("n", "needs-you"),
]), ["needs-you:n@0", "working:w@0", "idle:i@0", "snoozed:s@0"], "sections run needs-you, working, idle, snoozed");

assert.deepEqual(order([
  fact("n-old", "needs-you", { created: "2026-06-09T11:00:00.000Z", message: "2026-06-09T09:00:00.000Z" }),
  fact("n-none", "needs-you", { message: null }),
  fact("n-new", "needs-you", { created: "2026-06-09T08:00:00.000Z", message: "2026-06-09T10:00:00.000Z" }),
  fact("n-tie-b", "needs-you", { message: "2026-06-09T09:30:00.000Z" }),
  fact("n-tie-a", "needs-you", { message: "2026-06-09T09:30:00.000Z" }),
  fact("i-old", "idle", { message: "2026-06-09T07:00:00.000Z" }),
  fact("i-new", "idle", { message: "2026-06-09T08:00:00.000Z" }),
  fact("s-old", "idle", { message: "2026-06-09T05:00:00.000Z" }, { snooze: { kind: "until", until: "2026-06-10T09:00:00.000Z" } }),
  fact("s-new", "idle", { message: "2026-06-09T06:00:00.000Z" }, { snooze: { kind: "next-message" } }),
]), [
  "needs-you:n-new@0", "needs-you:n-tie-a@0", "needs-you:n-tie-b@0", "needs-you:n-old@0", "needs-you:n-none@0",
  "idle:i-new@0", "idle:i-old@0", "snoozed:s-new@0", "snoozed:s-old@0",
], "settled sections order by latest message, newest first, then id; no message sorts last");

assert.deepEqual(order([
  fact("w-old", "working", { created: "2026-06-09T08:00:00.000Z", message: "2026-06-09T11:00:00.000Z" }),
  fact("w-new", "working", { created: "2026-06-09T10:00:00.000Z", message: "2026-06-09T10:00:00.000Z" }),
]), ["working:w-new@0", "working:w-old@0"], "working orders by creation, newest first, whatever its latest message");

assert.deepEqual(order([
  fact("grandchild", "needs-you", {}, { parentThreadId: "child" }),
  fact("child-late", "idle", { created: "2026-06-09T10:30:00.000Z" }, { parentThreadId: "parent" }),
  fact("child", "idle", { created: "2026-06-09T10:00:00.000Z" }, { parentThreadId: "parent" }),
  fact("parent", "working"),
  fact("orphan", "needs-you", {}, { parentThreadId: "not-visible" }),
]), [
  "needs-you:orphan@0",
  "working:parent@0", "working:child-late@1", "working:child@1", "working:grandchild@2",
], "children follow their parent recursively in its section; an orphan is a root by its own section");

assert.deepEqual(order([
  fact("parent", "working", {}, { snooze: { kind: "next-message" } }),
  fact("child", "working", {}, { parentThreadId: "parent" }),
]), ["snoozed:parent@0", "snoozed:child@1"], "a held snooze outranks working, and the subtree moves with its root");

const wellFormed = [
  fact("a", "idle"), fact("b", "working"), fact("c", "needs-you", {}, { parentThreadId: "b" }),
  fact("d", "idle", {}, { parentThreadId: "c" }), fact("e", "needs-you", {}, { parentThreadId: "gone" }),
  fact("f", "idle", {}, { snooze: { kind: "next-message" } }), fact("g", "working", {}, { parentThreadId: "f" }),
];
assert.deepEqual(
  arrangeSessionState(wellFormed).map((r) => r.id).sort(),
  wellFormed.map((r) => r.id).sort(),
  "every input row is emitted exactly once",
);
assert.ok(wellFormed.every((r) => !("section" in r) && !("depth" in r)), "arrangement is pure: inputs untouched");

process.stdout.write("ok — session-state data model passed\n");
