// Integration: a parent's assessment reads its delegated runs from the run ledger, including a
// run whose child session Owner Operator never scanned (issue #216, contract case L8c). Such a
// child can run under another harness home, so the run row is the only record of how it ended.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRunHarness, AgentRunStatus, type ScanRow } from "@owner-operator/core";
import { State } from "./state";

const dir = mkdtempSync(join(tmpdir(), "oo-child-evidence-"));
const previousOoHome = process.env.OO_HOME;
process.env.OO_HOME = dir;

let now = "2026-11-24T10:00:00.000Z";
const tick = () => { now = new Date(Date.parse(now) + 1000).toISOString(); };
const scanRow = (id: string): ScanRow => ({
  id, source: "claude", repo: "probe", project: dir, app: "Claude CLI", topic: "probe", lastRole: "assistant",
  createdAt: now, lastMessageAt: now, secondsSinceLastMessage: 5, secondsSinceActivity: 5, working: false,
});

const state = new State(join(dir, "state.db"), { now: () => now, activeWindow: "1d" });
try {
  state.recordObservation(scanRow("parent"));
  const delegate = (childSessionId: string | null) => {
    const run = state.createAgentRun({ harness: AgentRunHarness.Codex, task: "probe", cwd: dir, parentThreadId: "parent", depth: 1, timeoutSeconds: 600 });
    state.claimNextPendingAgentRun(3);
    if (childSessionId) state.recordAgentRunActivity(run.id, { childSessionId, promptSubmitted: true });
    tick();
    return run;
  };
  const evidence = () => state.listEnrichmentCandidates().find(({ id }) => id === "parent")?.children ?? [];

  const unscanned = delegate("child-unscanned");
  state.finishAgentRun(unscanned.id, { status: AgentRunStatus.Completed, resultTail: "RESULT", error: null });
  tick();
  assert.deepEqual(
    evidence().find(({ runId }) => runId === unscanned.id),
    { id: "child-unscanned", source: AgentRunHarness.Codex, lastMessageAt: null, runId: unscanned.id, status: AgentRunStatus.Completed },
    "a completed run whose child session has no row is in the parent's evidence",
  );

  const scanned = delegate("child-scanned");
  state.recordObservation(scanRow("child-scanned"));
  const scannedChild = evidence().find(({ runId }) => runId === scanned.id);
  assert.equal(scannedChild?.id, "child-scanned");
  assert.equal(scannedChild?.source, "claude", "a scanned child keeps its session's source");
  assert.equal(scannedChild?.lastMessageAt, now, "a scanned child keeps its session's message time");

  const candidate = state.listEnrichmentCandidates().find(({ id }) => id === "parent")!;
  assert.ok(state.appendEnrichment(candidate.id, { topic: "t", statusSummary: "s", attention: "idle" }, candidate.lastMessageAt!, candidate.children));
  assert.ok(!state.listEnrichmentCandidates().some(({ id }) => id === "parent"), "an assessment of the ledger evidence settles the parent");
  state.recordObservation({ ...scanRow("child-unscanned"), lastMessageAt: now });
  assert.ok(state.listEnrichmentCandidates().some(({ id }) => id === "parent"), "the child's first scan is new evidence for the parent");

  console.log("ok - parent evidence reads child runs from the ledger without a child session row");
} finally {
  state.close();
  if (previousOoHome === undefined) delete process.env.OO_HOME; else process.env.OO_HOME = previousOoHome;
  rmSync(dir, { recursive: true, force: true });
}
