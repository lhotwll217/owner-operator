import assert from "node:assert/strict";
import { join } from "node:path";
import { State } from "./state";
import { fakeScanRow, tempOoHome } from "../gateway/test/helpers";

const { dir, cleanup } = tempOoHome("oo-awaiting-work");
const state = new State(join(dir, "state.db"), { now: () => "2026-06-09T12:00:00.000Z" });
const row = (id: string) => state.listCurrentSessionState().find((r) => r.id === id);
try {
  const stopped = fakeScanRow({ id: "awaiting", secondsSinceLastMessage: 4000 });
  state.recordObservation(stopped);
  const answer = { attention: "needs-you" as const, awaiting: true, topic: "Checkout audit", statusSummary: "Waiting on the checkout explorer." };
  assert.equal(state.appendEnrichment(stopped.id, answer, stopped.lastMessageAt), true);
  assert.equal(row(stopped.id)?.state, "working", "a stopped agent awaiting its own running work projects as working");
  state.recordObservation(stopped);
  assert.equal(row(stopped.id)?.state, "working", "polling the same message keeps the model's answer");
  assert.deepEqual(state.listEnrichmentCandidates().map((r) => r.id), [], "an awaiting row is not reassessed until a new message");

  const reported = { ...stopped, lastMessageAt: "2026-06-09T12:05:00.000Z" };
  state.recordObservation(reported);
  assert.equal(row(stopped.id)?.state, "idle", "the next message releases Working; no timer is involved");
  const candidate = state.listEnrichmentCandidates().find((r) => r.id === stopped.id);
  assert.equal(candidate?.state, "idle", "the released row is reassessed as a stopped session");

  assert.equal(state.appendEnrichment(stopped.id, { ...answer, awaiting: false }, reported.lastMessageAt), true);
  assert.equal(row(stopped.id)?.state, "needs-you", "a false answer clears Working");

  const done = fakeScanRow({ id: "awaiting-done", secondsSinceLastMessage: 4000 });
  state.recordObservation(done);
  state.appendEnrichment(done.id, { ...answer, attention: "idle" }, done.lastMessageAt);
  state.markThreadsDone([done.id]);
  assert.equal(row(done.id), undefined, "owner Done outranks awaiting work");
  console.log("ok - awaiting own work projects as working until the next message");
} finally {
  cleanup();
}
