// Integration: live delegated work at any depth keeps every ancestor Working, out of the
// needs-you schedule inputs, and inside the active window (issue #228).
//
// The lineage is root -> A -> B -> C and only C's run is live. Every thread above it went quiet
// days ago, so only the live run can explain their rows.
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRunHarness, AgentRunStatus, type ScanRow } from "@owner-operator/core";
import { InMemoryEventBus } from "./event-bus";
import { State } from "./state";

const dir = mkdtempSync(join(tmpdir(), "oo-live-descendant-"));
const previousOoHome = process.env.OO_HOME;
process.env.OO_HOME = dir;

const quietSince = "2026-11-20T10:00:00.000Z";
const scanRow = (id: string, topic: string): ScanRow => ({
  id,
  source: "claude",
  repo: "owner-operator",
  project: dir,
  app: "Claude Code CLI",
  topic,
  lastRole: "assistant",
  createdAt: quietSince,
  lastMessageAt: quietSince,
  secondsSinceLastMessage: 120,
  secondsSinceActivity: 120,
  working: false,
});

let closeState: (() => void) | undefined;
try {
  const state = new State(join(dir, "state.db"), {
    bus: new InMemoryEventBus(),
    now: () => "2026-11-23T13:30:00.000Z",
    activeWindow: "1d",
  });
  closeState = () => state.close();
  const visible = (id: string) => state.listCurrentSessionState().find((row) => row.id === id);
  const needsYouInputs = () => state.listNeedsYouMessageVersions().map(({ threadId }) => threadId);
  const delegate = (parentThreadId: string, depth: number, childSessionId?: string) => state.createAgentRun({
    harness: AgentRunHarness.ClaudeCode,
    task: `delegate from ${parentThreadId}`,
    cwd: dir,
    parentThreadId,
    depth,
    timeoutSeconds: 3_600,
    ...(childSessionId ? { childSessionId } : {}),
  });
  const complete = (id: string) =>
    state.finishAgentRun(id, { status: AgentRunStatus.Completed, resultTail: "yielded", error: null });

  state.recordObservation(scanRow("root", "Release orchestration"));
  state.appendEnrichment("root", { topic: "Release orchestration", statusSummary: "Waiting on the owner", attention: "needs-you" }, quietSince);
  state.recordObservation(scanRow("thread-a", "Orchestrator, depth 1"));
  state.recordObservation(scanRow("thread-b", "Orchestrator, depth 2"));
  complete(delegate("root", 1, "thread-a").id);
  complete(delegate("thread-a", 2, "thread-b").id);
  assert.equal(visible("root")?.state, "needs-you", "with no live work below it, the root keeps its own state");
  assert.equal(visible("thread-a"), undefined, "a quiet finished child with nothing live below it leaves the view");

  const deepest = delegate("thread-b", 3);
  for (const id of ["thread-b", "thread-a", "root"]) {
    assert.equal(visible(id)?.state, "working", `${id} above the live run is working and inside the active window`);
  }
  assert.ok(!needsYouInputs().includes("root"), "a root above live work is not a needs-you schedule input");

  complete(deepest.id);
  assert.equal(visible("root")?.state, "needs-you", "the root returns to its own state once the lineage settles");
  assert.equal(visible("thread-a"), undefined, "the quiet ancestor leaves the view once the lineage settles");
  assert.ok(needsYouInputs().includes("root"), "the settled root is a needs-you schedule input again");

  process.stdout.write("ok - live work at any depth keeps its ancestors working and visible\n");
} finally {
  closeState?.();
  if (previousOoHome === undefined) delete process.env.OO_HOME;
  else process.env.OO_HOME = previousOoHome;
  rmSync(dir, { recursive: true, force: true });
}
