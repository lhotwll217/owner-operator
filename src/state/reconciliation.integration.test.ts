import assert from "node:assert/strict";
import { join } from "node:path";
import { State } from "./state";
import { SessionMonitor } from "../session-monitor/monitor";
import { fakeScanRow, tempOoHome, waitFor } from "../gateway/test/helpers";
import { AgentRunHarness, AgentRunStatus, DomainEventKind, type DomainEvent, type ThreadEnrichment } from "@owner-operator/core";

const { dir, cleanup } = tempOoHome("oo-reconcile-state");
const state = new State(join(dir, "state.db"), { now: () => "2026-06-09T12:00:00.000Z" });
let attempts = 0;
let row = fakeScanRow();
const monitor = new SessionMonitor(state, {
  scan: async () => [row],
  enrich: async () => {
    attempts++;
    if (attempts === 1) throw new Error("temporary model outage");
    return { topic: "Completed repair", attention: "idle" as const, summary: "The requested repair and verification are complete.", priority: 2 };
  },
});
try {
  await monitor.poll();
  await waitFor(() => attempts === 1, 1000, "first enrichment attempt");
  await new Promise((resolve) => setTimeout(resolve, 10));
  row = { ...row, secondsSinceLastMessage: 4000 };
  await monitor.poll();
  await waitFor(() => attempts === 2, 1000, "retry after needs-you becomes idle");
  await waitFor(() => state.listSessionState()[0]?.generatedTopic === "Completed repair", 1000, "completed task receives an updated title");
  assert.equal(state.listSessionState()[0]?.state, "idle", "reported completion stays visible until explicitly marked done");
  assert.deepEqual(state.requestEnrichment([{ id: row.id, lastMessageAt: row.lastMessageAt }]), [row.id]);
  assert.equal(state.appendEnrichment(row.id, { attention: "done", summary: "Complete", topic: "Session progress", priority: 2 } as unknown as ThreadEnrichment, row.lastMessageAt), false, "even a fresh eligible assessment cannot mark work done");
  state.markThreadsDone([row.id]);
  await monitor.poll();
  assert.equal(state.listSessionState().length, 0, "poll preserves explicit done");

  const unresolved = fakeScanRow({ id: "unresolved", secondsSinceLastMessage: 4000 });
  state.recordObservation(unresolved);
  const decision = { attention: "needs-you" as const, summary: "The owner has not answered the behavior question.", topic: "Session progress", priority: 2 };
  assert.equal(state.appendEnrichment(unresolved.id, decision, unresolved.lastMessageAt), true);
  state.recordObservation(unresolved);
  assert.equal(state.listCurrentSessionState()[0]?.state, "needs-you", "genuine old decisions survive polling");
  const child = state.createAgentRun({ harness: AgentRunHarness.ClaudeCode, task: "Implement the replacement", cwd: dir, parentThreadId: unresolved.id, depth: 1, timeoutSeconds: 60 });
  assert.equal(state.listCurrentSessionState()[0]?.summary, decision.summary, "active replacement keeps the last recap until a new one lands");
  assert.equal(state.listCurrentSessionState()[0]?.summaryPending, true, "the retained recap is marked behind the current work");
  assert.deepEqual(state.requestEnrichment([{ id: unresolved.id, lastMessageAt: unresolved.lastMessageAt }]), [unresolved.id], "active delegated work accepts summary recovery");
  state.finishAgentRun(child.id, { status: AgentRunStatus.Completed, resultTail: "Replacement implemented", error: null });
  assert.deepEqual(state.requestEnrichment([{ id: unresolved.id, lastMessageAt: "2000-01-01T00:00:00.000Z" }]), [], "a stale recovery snapshot cannot invalidate current work");
  const recoveryEvents: DomainEvent[] = [];
  const unsubscribe = state.bus.subscribe((event) => { recoveryEvents.push(event); });
  assert.deepEqual(state.requestEnrichment([{ id: unresolved.id, lastMessageAt: unresolved.lastMessageAt }]), [unresolved.id]);
  await waitFor(() => recoveryEvents.length > 0, 1000, "recovery invalidation");
  unsubscribe();
  assert.equal(recoveryEvents[0]?.kind, DomainEventKind.ThreadChanged, "recovery invalidates clients after the watermark commit");
  assert.equal(state.listCurrentSessionState()[0]?.summary, decision.summary, "recovery keeps the last recap while the retry is pending");
  assert.equal(state.listCurrentSessionState()[0]?.summaryPending, true, "recovery marks the retained recap pending");
  assert.equal(state.listEnrichmentCandidates()[0]?.id, unresolved.id, "already summarized rows can use the existing enrichment worker again");
  state.markThreadsDone([unresolved.id]);
  assert.deepEqual(state.requestEnrichment([{ id: unresolved.id, lastMessageAt: unresolved.lastMessageAt }]), [], "recovery preserves owner done");
  assert.equal(state.appendEnrichment(unresolved.id, decision, unresolved.lastMessageAt), false, "owner done wins over model output");
  const fresh = { ...unresolved, lastMessageAt: "2026-09-09T20:00:00.000Z", secondsSinceLastMessage: 30 };
  state.recordObservation(fresh);
  const reopened = state.listSessionState()[0];
  assert.equal(reopened?.summary, decision.summary, "a new message keeps the last recap on screen");
  assert.equal(reopened?.summaryPending, true, "a new message does not present the previous owner action as current");
  assert.equal(state.appendEnrichment(fresh.id, decision, unresolved.lastMessageAt), false, "old evidence cannot close or change new work");
  const active = state.createAgentRun({ harness: AgentRunHarness.ClaudeCode, task: "Continue", cwd: dir, parentThreadId: fresh.id, depth: 1, timeoutSeconds: 60 });
  state.markThreadsDone([fresh.id]);
  assert.equal(state.listSessionState().length, 0, "an active child cannot undo an explicit owner done choice");
  state.finishAgentRun(active.id, { status: AgentRunStatus.Completed, resultTail: "Complete", error: null });

  const worker = fakeScanRow({ id: "worker", working: true, lastRole: "user", lastMessageAt: "2026-06-09T11:55:00.000Z", secondsSinceLastMessage: 300, secondsSinceActivity: 300 });
  state.recordObservation(worker);
  assert.equal(state.listCurrentSessionState().find((r) => r.id === "worker")?.state, "working", "active work is visible under the configured window");
  assert.ok(state.listEnrichmentCandidates().some((r) => r.id === "worker"), "a working row is eligible for its first summary");
  assert.equal(state.appendEnrichment("worker", { attention: "idle", summary: "Settled.", topic: "Session progress", priority: 2 }, worker.lastMessageAt), true, "attention does not gate a working summary");
  state.requestEnrichment([{ id: "worker", lastMessageAt: worker.lastMessageAt }]);
  assert.equal(state.appendEnrichment("worker", { attention: "needs-you", summary: "Question.", topic: "Session progress", priority: 2 }, worker.lastMessageAt), true, "attention cannot change working lifecycle state");
  state.requestEnrichment([{ id: "worker", lastMessageAt: worker.lastMessageAt }]);
  assert.equal(state.appendEnrichment("worker", { attention: "idle", topic: "Export implementation", priority: 3, summary: "Implementing the export." }, worker.lastMessageAt), true, "a working affirmation lands the title and current-activity summary");
  const summarizedWorker = state.listCurrentSessionState().find((r) => r.id === "worker");
  assert.equal(summarizedWorker?.state, "working", "summarization preserves the working lifecycle state");
  assert.equal(summarizedWorker?.generatedTopic, "Export implementation");
  assert.equal(summarizedWorker?.summary, "Implementing the export.", "a working row projects its current summary");
  assert.deepEqual(state.requestEnrichment([{ id: "worker", lastMessageAt: worker.lastMessageAt }]), ["worker"], "POST /poll recovery accepts working rows");
  const settled = fakeScanRow({ id: "settled", lastMessageAt: "2026-06-09T11:50:00.000Z", secondsSinceLastMessage: 4000, secondsSinceActivity: 4000 });
  state.recordObservation(settled);
  assert.equal(state.listCurrentSessionState().find((r) => r.id === "settled")?.state, "idle");
  assert.equal(state.appendEnrichment("settled", { attention: "idle", summary: "Active.", topic: "Session progress", priority: 2 }, settled.lastMessageAt), true, "progress descriptions cannot activate a settled row");
  assert.equal(state.listSessionState().find(({ id }) => id === "settled")?.state, "idle");
  console.log("ok - failed enrichment recovers while idle, explicit done persists, unresolved decisions survive");
} finally {
  monitor.stop();
  state.close();
  cleanup();
}
