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
  assert.deepEqual(parseDetails(JSON.stringify(presentation)), presentation);
  for (const attention of ["working", "done"]) {
    assert.throws(() => parseDetails(JSON.stringify({ ...presentation, attention })), /attention/);
  }
  for (const field of ["topic", "summary", "priority"]) {
    assert.throws(() => parseDetails(JSON.stringify({ ...presentation, [field]: undefined })), new RegExp(field));
  }
  const worker = fakeScanRow({ id: "first-message", working: true, lastRole: "user" });
  state.recordObservation(worker);
  const details = parseDetails(JSON.stringify(presentation));
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
  state.finishAgentRun(child.id, { status: AgentRunStatus.Completed, resultTail: "Export implemented", error: null });
  assert.ok(state.listEnrichmentCandidates().some(({ id }) => id === parent.id), "child settlement makes parent eligible again");
  state.markThreadsDone([parent.id]);
  assert.equal(state.appendEnrichment(parent.id, details, parent.lastMessageAt), false);
  console.log("ok - typed summaries, first message, working updates, pinned title, stale guard, direct idle, active child, explicit Done");
} finally {
  state.close();
  cleanup();
}
