import assert from "node:assert/strict";
import { join } from "node:path";
import { AgentRunHarness, AgentRunStatus } from "@owner-operator/core";
import { State } from "./state";
import { fakeScanRow, tempOoHome } from "../gateway/test/helpers";
import { parseDetails } from "../agent/enrichment";

const { dir, cleanup } = tempOoHome("oo-summary-contract");
const state = new State(join(dir, "state.db"), { now: () => "2026-06-09T12:00:00.000Z" });
try {
  const presentation = { topic: "Export implementation", summary: "Implementing the requested export.", priority: 3, attention: "idle" };
  const response = { ...presentation, ownerAction: null };
  assert.deepEqual(parseDetails(JSON.stringify(response)), presentation);
  for (const field of ["topic", "summary", "priority"]) {
    assert.throws(() => parseDetails(JSON.stringify({ ...response, [field]: undefined })), new RegExp(field));
  }
  const worker = fakeScanRow({ id: "first-message", working: true, lastRole: "user" });
  state.recordObservation(worker);
  const details = parseDetails(JSON.stringify(response));
  assert.equal(state.appendEnrichment(worker.id, details, worker.lastMessageAt), true);
  assert.equal(state.listSessionState()[0].state, "working");
  assert.equal(state.listSessionState()[0].summary, presentation.summary);
  state.renameThread(worker.id, "Pinned export");
  const newer = { ...worker, lastMessageAt: "2026-06-09T11:59:00.000Z" };
  state.recordObservation(newer);
  assert.equal(state.appendEnrichment(worker.id, details, worker.lastMessageAt), false);
  assert.equal(state.appendEnrichment(worker.id, { ...details, summary: "Writing export tests." }, newer.lastMessageAt), true);
  assert.equal(state.listSessionState()[0].topic, "Pinned export");
  state.recordObservation({ ...newer, working: false, secondsSinceLastMessage: 4000, secondsSinceActivity: 4000 });
  assert.equal(state.listSessionState()[0].state, "idle", "same-message settling cannot preserve a working assessment");
  assert.ok(state.listEnrichmentCandidates().some(({ id }) => id === worker.id), "settling needs a fresh attention assessment");
  const parent = fakeScanRow({ id: "parent", secondsSinceLastMessage: 4000 });
  state.recordObservation(parent);
  const child = state.createAgentRun({ harness: AgentRunHarness.ClaudeCode, task: "Export", cwd: dir, parentThreadId: parent.id, depth: 1, timeoutSeconds: 60 });
  assert.ok(state.listEnrichmentCandidates().some(({ id }) => id === parent.id));
  assert.equal(state.appendEnrichment(parent.id, details, parent.lastMessageAt), true);
  assert.equal(state.listSessionState().find(({ id }) => id === parent.id)?.summary, presentation.summary);
  assert.equal(state.listSessionState().find(({ id }) => id === parent.id)?.state, "working");
  const childRow = fakeScanRow({ id: "child-session", working: true });
  state.recordObservation(childRow);
  state.claimNextPendingAgentRun(1);
  state.recordAgentRunActivity(child.id, { childSessionId: childRow.id });
  assert.ok(state.listEnrichmentCandidates().some(({ id }) => id === parent.id), "a newly observed child invalidates the parent summary");
  const sampled = state.listEnrichmentCandidates().find(({ id }) => id === parent.id)!;
  assert.equal(state.appendEnrichment(parent.id, details, parent.lastMessageAt, sampled.children), true);
  state.recordObservation({ ...childRow, lastMessageAt: "2026-06-09T11:59:30.000Z" });
  assert.ok(state.listEnrichmentCandidates().some(({ id }) => id === parent.id), "child-only progress invalidates the parent summary");
  assert.equal(state.appendEnrichment(parent.id, details, parent.lastMessageAt, sampled.children), false, "child progress rejects an in-flight parent summary");
  const progressed = state.listEnrichmentCandidates().find(({ id }) => id === parent.id)!;
  assert.equal(state.appendEnrichment(parent.id, details, parent.lastMessageAt, progressed.children), true);
  assert.ok(!state.listEnrichmentCandidates().some(({ id }) => id === parent.id), "unchanged child evidence does not repeat enrichment");
  state.finishAgentRun(child.id, { status: AgentRunStatus.Completed, resultTail: "Export implemented", error: null });
  assert.ok(state.listEnrichmentCandidates().some(({ id }) => id === parent.id), "child settlement makes parent eligible again");
  state.markThreadsDone([parent.id]);
  assert.equal(state.appendEnrichment(parent.id, details, parent.lastMessageAt), false);

  // ---- title and recap lifecycle ------------------------------------------------------
  // A title is visible from the first observation, a generated one replaces the opening
  // prompt, and from then on it identifies the work: ordinary progress leaves it alone and
  // only a categorically different task renames the row. The last recap stays on screen
  // while its replacement is pending, so a refresh never puts prompt text back.
  const rowOf = (id: string) => state.listSessionState().find((row) => row.id === id)!;
  const lifecycle = fakeScanRow({ id: "lifecycle", topic: "please look at the export thing for me when you get a chance", secondsSinceLastMessage: 4000 });
  state.recordObservation(lifecycle);
  assert.equal(rowOf(lifecycle.id).topic, lifecycle.topic, "a row carries a title from its first observation");
  assert.equal(rowOf(lifecycle.id).generatedTopic, "", "the opening prompt is a placeholder, not a generated title");
  assert.equal(rowOf(lifecycle.id).summary, null, "no recap exists before one is generated");

  const generated = { topic: "Export retention policy", summary: "Deciding the export's retention policy.", priority: 3, attention: "idle" as const };
  assert.equal(state.appendEnrichment(lifecycle.id, generated, lifecycle.lastMessageAt), true);
  assert.equal(rowOf(lifecycle.id).topic, generated.topic, "the generated title replaces the opening prompt");
  assert.equal(rowOf(lifecycle.id).summaryPending, false, "a current recap is not pending");

  const moved = { ...lifecycle, lastMessageAt: "2026-06-09T11:58:00.000Z" };
  state.recordObservation(moved);
  assert.equal(rowOf(lifecycle.id).topic, generated.topic, "new activity leaves the title in place");
  assert.equal(rowOf(lifecycle.id).summary, generated.summary, "the last recap is retained while its replacement is pending");
  assert.equal(rowOf(lifecycle.id).summaryPending, true, "a newer message marks the recap pending");

  assert.equal(state.appendEnrichment(lifecycle.id, { ...generated, summary: "Retention policy chosen; writing the export." }, moved.lastMessageAt), true);
  assert.equal(rowOf(lifecycle.id).topic, generated.topic, "a repeated title is the same row, not a new identity");
  assert.equal(rowOf(lifecycle.id).summary, "Retention policy chosen; writing the export.", "the recap follows the work");
  assert.equal(rowOf(lifecycle.id).summaryPending, false);

  const pivoted = { ...lifecycle, lastMessageAt: "2026-06-09T11:59:00.000Z" };
  state.recordObservation(pivoted);
  assert.equal(state.appendEnrichment(lifecycle.id, { topic: "Billing webhook outage", summary: "The export is parked; the billing webhook is down.", priority: 2, attention: "idle" }, pivoted.lastMessageAt), true);
  assert.equal(rowOf(lifecycle.id).topic, "Billing webhook outage", "a categorically different task earns a new title");

  state.renameThread(lifecycle.id, "My export work");
  const afterPin = { ...lifecycle, lastMessageAt: "2026-06-09T11:59:40.000Z" };
  state.recordObservation(afterPin);
  assert.equal(state.appendEnrichment(lifecycle.id, { topic: "Something else entirely", summary: "Still on the webhook.", priority: 2, attention: "idle" }, afterPin.lastMessageAt), true);
  assert.equal(rowOf(lifecycle.id).topic, "My export work", "an owner-pinned title outlives every generated one");
  assert.equal(rowOf(lifecycle.id).generatedTopic, "Something else entirely", "the generated title keeps landing underneath");

  // ---- queue order --------------------------------------------------------------------
  // Enrichment runs one thread at a time, so the row still showing prompt text waits behind
  // whatever is in front of it. Newer work goes first, except that a row with no title yet
  // goes before any refresh: that row is the one the owner cannot read.
  const untitled = fakeScanRow({ id: "untitled", topic: "could you look at the thing from yesterday", lastMessageAt: "2026-06-09T11:00:00.000Z", secondsSinceLastMessage: 4000 });
  const titledOlder = fakeScanRow({ id: "titled-older", lastMessageAt: "2026-06-09T11:30:00.000Z", secondsSinceLastMessage: 4000 });
  const titledNewer = fakeScanRow({ id: "titled-newer", lastMessageAt: "2026-06-09T11:45:00.000Z", secondsSinceLastMessage: 4000 });
  for (const row of [untitled, titledOlder, titledNewer]) state.recordObservation(row);
  for (const row of [titledOlder, titledNewer]) {
    assert.equal(state.appendEnrichment(row.id, { topic: "Export work", summary: "Exporting.", priority: 3, attention: "idle" }, row.lastMessageAt), true);
    state.recordObservation({ ...row, lastMessageAt: `${row.lastMessageAt.slice(0, 19)}.500Z` });
  }
  const queue = state.listEnrichmentCandidates().map((row) => row.id).filter((id) => id.startsWith("titled") || id === "untitled");
  assert.deepEqual(queue, ["untitled", "titled-newer", "titled-older"], "a row with no title yet is generated before any refresh");

  console.log("ok - typed summaries, first message, working updates, pinned title, stale guard, direct idle, active child, explicit Done, title lifecycle, retained recap, queue order");
} finally {
  state.close();
  cleanup();
}
