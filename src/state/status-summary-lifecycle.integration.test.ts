// The status summary's life: what the owner reads, when it is reassessed, and what a later
// reader can return to. A revision is written when the meaning changes; reassessment
// bookkeeping moves on its own schedule and leaves the text and its version alone.
import assert from "node:assert/strict";
import { join } from "node:path";
import { State } from "./state";
import { fakeScanRow, tempOoHome } from "../gateway/test/helpers";

const { dir, cleanup } = tempOoHome("oo-status-summary-lifecycle");
let clock = "2026-06-09T12:00:00.000Z";
const at = (iso: string) => { clock = iso; };
const state = new State(join(dir, "state.db"), { now: () => clock });

const assessment = (over: Partial<{ topic: string; summary: string; priority: number; attention: "idle" | "needs-you"; bookmark: { index: number; messageAt: string } }> = {}) => ({
  topic: "Export retention policy",
  summary: "Retention policy chosen. Export implementation in progress.",
  priority: 3,
  attention: "idle" as const,
  ...over,
});

try {
  // ---- a revision records where it was written from ------------------------------------
  const thread = fakeScanRow({ id: "bookmarked", lastMessageAt: "2026-06-09T11:40:00.000Z", secondsSinceLastMessage: 4000 });
  state.recordObservation(thread);
  const beforeModel = state.latestDetails(thread.id)!;
  assert.equal(beforeModel.writtenBy, "poll");
  assert.equal(beforeModel.bookmarkIndex, null, "an observation records no session position");

  assert.equal(
    state.appendEnrichment(thread.id, assessment({ bookmark: { index: 41, messageAt: thread.lastMessageAt } }), thread.lastMessageAt),
    true,
  );
  const written = state.latestDetails(thread.id)!;
  assert.equal(written.writtenBy, "model");
  assert.equal(written.bookmarkIndex, 41, "a status-summary revision records the position it was written from");
  assert.equal(written.bookmarkMessageAt, thread.lastMessageAt, "and the message time at that position");

  // ---- an unchanged understanding keeps its text and its version -------------------------
  const progressed = { ...thread, lastMessageAt: "2026-06-09T11:45:00.000Z" };
  state.recordObservation(progressed);
  assert.ok(state.listEnrichmentCandidates().some((row) => row.id === thread.id), "new activity asks for a reassessment");
  assert.equal(
    state.appendEnrichment(thread.id, assessment({ priority: 5, bookmark: { index: 52, messageAt: progressed.lastMessageAt } }), progressed.lastMessageAt),
    true,
    "the reassessment lands",
  );
  const unchanged = state.latestDetails(thread.id)!;
  assert.equal(unchanged.version, written.version, "the same understanding creates no new version");
  assert.equal(unchanged.summary, written.summary, "and leaves the text alone");
  assert.equal(unchanged.bookmarkIndex, written.bookmarkIndex, "the recorded position belongs to the revision, not the reassessment");
  assert.ok(
    !state.listEnrichmentCandidates().some((row) => row.id === thread.id),
    "freshness bookkeeping advanced even though nothing was written",
  );

  const moved = { ...thread, lastMessageAt: "2026-06-09T11:50:00.000Z" };
  state.recordObservation(moved);
  assert.equal(
    state.appendEnrichment(thread.id, assessment({ summary: "Export implemented. Verification still open.", bookmark: { index: 63, messageAt: moved.lastMessageAt } }), moved.lastMessageAt),
    true,
  );
  const changed = state.latestDetails(thread.id)!;
  assert.equal(changed.version, written.version + 1, "a changed understanding is a new revision");
  assert.equal(changed.bookmarkIndex, 63, "which records its own position");

  // ---- a working session is reassessed on a cadence, without new messages ----------------
  // A long turn produces no new message for minutes at a time. The owner is reading that row,
  // so the assessment behind it is repeated on a schedule rather than waiting for the turn.
  at("2026-06-09T12:10:00.000Z");
  const working = fakeScanRow({ id: "working", working: true, lastRole: "user", lastMessageAt: "2026-06-09T12:09:30.000Z", secondsSinceLastMessage: 30 });
  state.recordObservation(working);
  assert.equal(state.appendEnrichment(working.id, assessment({ bookmark: { index: 8, messageAt: working.lastMessageAt } }), working.lastMessageAt), true);
  assert.ok(!state.listEnrichmentCandidates().some((row) => row.id === working.id), "a just-assessed working row waits");

  at("2026-06-09T12:12:00.000Z");
  state.recordObservation(working);
  assert.ok(!state.listEnrichmentCandidates().some((row) => row.id === working.id), "two minutes later it still waits");

  at("2026-06-09T12:14:30.000Z");
  state.recordObservation(working);
  assert.ok(
    state.listEnrichmentCandidates().some((row) => row.id === working.id),
    "past the working cadence the same session is reassessed without a new message",
  );

  // An idle row has no such cadence: it waits for activity.
  at("2026-06-09T12:30:00.000Z");
  assert.ok(!state.listEnrichmentCandidates().some((row) => row.id === thread.id), "a settled row is not reassessed on a timer");

  console.log("ok - status-summary revisions carry a position, unchanged understanding holds, working rows reassess on cadence");
} finally {
  state.close();
  cleanup();
}
