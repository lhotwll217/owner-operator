import assert from "node:assert/strict";
import { join } from "node:path";
import { ScheduleKind, ScheduledPayloadKind, type ScheduleDefinition } from "@owner-operator/core";
import { State } from "./state";
import { fakeScanRow, tempOoHome } from "../gateway/test/helpers";

const { dir, cleanup } = tempOoHome("oo-awaiting-work");
let clock = "2026-06-09T12:00:00.000Z";
const state = new State(join(dir, "state.db"), { now: () => clock, activeWindow: "1d" });
const schedule: ScheduleDefinition = {
  id: "on-needs-you", name: "On Need You", enabled: true, trigger: { kind: ScheduleKind.NeedsYou },
  payload: { kind: ScheduledPayloadKind.Prompt, prompt: "Triage." }, cwd: dir, timeoutSeconds: 60, revision: 1,
  createdAt: clock, updatedAt: clock, nextRunAt: null,
};
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
  state.saveSchedule(schedule);
  assert.deepEqual(state.listNeedsYouMessageVersions(), [], "a row shown as Working is not offered to Need You schedules");
  assert.equal(state.claimNeedsYouScheduleRun(schedule, [{ threadId: stopped.id, lastMessageAt: stopped.lastMessageAt }]), null,
    "a Need You schedule does not run for a row shown as Working");
  const background = fakeScanRow({ id: "awaiting-idle", secondsSinceLastMessage: 60 });
  state.recordObservation(background);
  state.appendEnrichment(background.id, { ...answer, attention: "idle" }, background.lastMessageAt);
  clock = "2026-06-10T13:00:00.000Z";
  assert.equal(row(background.id)?.state, "working", "awaiting work stays visible past the active window, with no timer");
  clock = "2026-06-09T12:00:00.000Z";

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
