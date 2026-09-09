import assert from "node:assert/strict";
import { join } from "node:path";
import { State } from "./state";
import { SessionMonitor } from "../session-monitor/monitor";
import { fakeScanRow, tempOoHome, waitFor } from "../gateway/test/helpers";
import { AgentRunHarness, AgentRunStatus, DomainEventKind, type DomainEvent } from "@owner-operator/core";

const { dir, cleanup } = tempOoHome("oo-reconcile-state");
const state = new State(join(dir, "state.db"));
let attempts = 0;
let row = fakeScanRow();
const monitor = new SessionMonitor(state, {
  scan: async () => [row],
  enrich: async () => {
    attempts++;
    if (attempts === 1) throw new Error("temporary model outage");
    return { topic: "Completed repair", nextSteps: "", state: "done" as const, stateReason: "The requested repair and verification are complete." };
  },
});
try {
  await monitor.poll();
  await waitFor(() => attempts === 1, 1000, "first enrichment attempt");
  await new Promise((resolve) => setTimeout(resolve, 10));
  row = { ...row, secondsSinceLastMessage: 4000 };
  await monitor.poll();
  await waitFor(() => attempts === 2, 1000, "retry after needs-you becomes idle");
  await waitFor(() => state.listSessionState().length === 0, 1000, "evidence-based completion");
  await monitor.poll();
  assert.equal(state.listSessionState().length, 0, "poll does not reopen reconciled completion");

  const unresolved = fakeScanRow({ id: "unresolved", secondsSinceLastMessage: 4000 });
  state.recordObservation(unresolved);
  const decision = { nextSteps: "Choose the required behavior", state: "needs-you" as const, stateReason: "The owner has not answered the behavior question." };
  assert.equal(state.appendEnrichment(unresolved.id, decision, unresolved.lastMessageAt), true);
  state.recordObservation(unresolved);
  assert.equal(state.listCurrentSessionState()[0]?.state, "needs-you", "genuine old decisions survive polling");
  const child = state.createAgentRun({ harness: AgentRunHarness.ClaudeCode, task: "Implement the replacement", cwd: dir, parentThreadId: unresolved.id, depth: 1, timeoutSeconds: 60 });
  assert.equal(state.listCurrentSessionState()[0]?.nextSteps, null, "an active replacement removes the obsolete owner instruction");
  assert.deepEqual(state.requestEnrichment([{ id: unresolved.id, lastMessageAt: unresolved.lastMessageAt }]), [], "active delegated work rejects recovery");
  state.finishAgentRun(child.id, { status: AgentRunStatus.Completed, resultTail: "Replacement implemented", error: null });
  assert.deepEqual(state.requestEnrichment([{ id: unresolved.id, lastMessageAt: "2000-01-01T00:00:00.000Z" }]), [], "a stale recovery snapshot cannot invalidate current work");
  const recoveryEvents: DomainEvent[] = [];
  const unsubscribe = state.bus.subscribe((event) => { recoveryEvents.push(event); });
  assert.deepEqual(state.requestEnrichment([{ id: unresolved.id, lastMessageAt: unresolved.lastMessageAt }]), [unresolved.id]);
  await waitFor(() => recoveryEvents.length > 0, 1000, "recovery invalidation");
  unsubscribe();
  assert.equal(recoveryEvents[0]?.kind, DomainEventKind.ThreadChanged, "recovery invalidates clients after the watermark commit");
  assert.equal(state.listCurrentSessionState()[0]?.nextSteps, null, "recovery removes the invalidated action while retry is pending");
  assert.equal(state.listEnrichmentCandidates()[0]?.id, unresolved.id, "already summarized rows can use the existing enrichment worker again");
  state.markThreadsDone([unresolved.id]);
  assert.deepEqual(state.requestEnrichment([{ id: unresolved.id, lastMessageAt: unresolved.lastMessageAt }]), [], "recovery preserves owner done");
  assert.equal(state.appendEnrichment(unresolved.id, decision, unresolved.lastMessageAt), false, "owner done wins over model output");
  const fresh = { ...unresolved, lastMessageAt: "2026-09-09T20:00:00.000Z", secondsSinceLastMessage: 30 };
  state.recordObservation(fresh);
  assert.equal(state.listSessionState()[0]?.nextSteps, null, "a new message does not reuse the previous owner action");
  assert.equal(state.appendEnrichment(fresh.id, decision, unresolved.lastMessageAt), false, "old evidence cannot close or change new work");
  const active = state.createAgentRun({ harness: AgentRunHarness.ClaudeCode, task: "Continue", cwd: dir, parentThreadId: fresh.id, depth: 1, timeoutSeconds: 60 });
  state.markThreadsDone([fresh.id]);
  assert.equal(state.listSessionState().length, 0, "an active child cannot undo an explicit owner done choice");
  state.finishAgentRun(active.id, { status: AgentRunStatus.Completed, resultTail: "Complete", error: null });
  console.log("ok - failed enrichment recovers while idle, completion persists, unresolved decisions survive");
} finally {
  monitor.stop();
  state.close();
  cleanup();
}
