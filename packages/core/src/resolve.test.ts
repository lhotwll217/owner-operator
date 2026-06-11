// Deterministic test of the canonical resolver — the one rule every surface shares for
// thread state/visibility. Pure functions, no model, no I/O.
//   npm test   (from packages/core/)

import assert from "node:assert";
import { holdsDone, resolveState, isActiveState, resolveCandidates } from "./resolve.mjs";

const AT = "2026-06-09T10:05:00.000Z";
const NEWER = "2026-06-09T10:06:00.000Z";

const cand = (over: Partial<{ id: string; lastRole: string; secondsSinceActivity: number; working: boolean; lastMessageAt: string }> = {}) => ({
  id: "a", lastRole: "assistant", secondsSinceActivity: 60, working: false, lastMessageAt: AT, ...over,
});
const doneAt = (lastMessageAt: string) => ({ id: "a", state: "done" as const, lastMessageAt });

// --- holdsDone: operator-set done survives until a NEWER message lands ---
assert.equal(holdsDone(undefined, cand()), false, "no persisted state → nothing holds");
assert.equal(holdsDone(doneAt(AT), cand()), true, "same lastMessageAt → done holds");
assert.equal(holdsDone(doneAt(NEWER), cand()), true, "older candidate → done holds");
assert.equal(holdsDone(doneAt(AT), cand({ lastMessageAt: NEWER })), false, "newer message → done releases");
assert.equal(holdsDone({ id: "a", state: "idle" as const, lastMessageAt: AT }, cand()), false, "only done holds; scan states never do");

// --- resolveState: done-hold wins, otherwise the scan-derived state ---
assert.equal(resolveState(doneAt(AT), cand()), "done", "held done resolves done");
assert.equal(resolveState(doneAt(AT), cand({ lastMessageAt: NEWER })), "needs-you", "woken thread resolves from scan facts");
assert.equal(resolveState(undefined, cand({ lastRole: "user" })), "working", "no persisted state → derived state");

// --- isActiveState: done leaves active surfaces, everything else stays ---
assert.equal(isActiveState("done"), false);
for (const s of ["needs-you", "working", "idle"] as const) assert.equal(isActiveState(s), true, `${s} is active`);

// --- resolveCandidates: the bulk join every scan entry point uses ---
const rows = [cand(), cand({ id: "b", lastRole: "user" })];
const persisted = [doneAt(AT)];

const visible = resolveCandidates(rows, persisted);
assert.deepEqual(visible.map((t) => t.id), ["b"], "held-done rows leave by default");
assert.equal(visible[0].state, "working", "survivors carry their resolved state");

const audited = resolveCandidates(rows, persisted, { includeDone: true });
assert.deepEqual(audited.map((t) => [t.id, t.state]), [["a", "done"], ["b", "working"]], "includeDone keeps + annotates");

assert.deepEqual(resolveCandidates(rows, null).map((t) => t.id), ["a", "b"], "no store yet → all candidates pass");
assert.equal(resolveCandidates([cand({ lastMessageAt: NEWER })], persisted)[0].state, "needs-you", "newer message wakes through the bulk join");
assert.equal((rows[0] as { state?: string }).state, undefined, "pure — inputs untouched");

process.stdout.write("ok — canonical resolver passed\n");
