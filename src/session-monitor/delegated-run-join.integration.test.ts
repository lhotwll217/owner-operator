// Integration: a delegated run's child transcript, once observed by the monitor's normal
// scan path, nests under its parent instead of appearing as an unexplained flat thread.
// The join key is identity — agent_runs.child_session_id == the observed thread id — never
// inference from transcript-file growth (the pattern issue #69 bans).
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRunHarness, type ScanRow } from "@owner-operator/core";
import { InMemoryEventBus } from "../state/event-bus";
import { State } from "../state/state";

const dir = mkdtempSync(join(tmpdir(), "oo-delegated-join-"));
process.env.OO_HOME = dir;

const scanRow = (id: string): ScanRow => ({
  id,
  source: "claude",
  repo: "owner-operator",
  project: dir,
  app: "Claude Code",
  topic: "delegated research",
  lastRole: "assistant",
  createdAt: "2026-07-17T10:00:00.000Z",
  lastMessageAt: "2026-07-17T10:05:00.000Z",
  secondsSinceLastMessage: 30,
  secondsSinceActivity: 30,
  working: true,
});

try {
  const state = new State(join(dir, "state.db"), {
    bus: new InMemoryEventBus(),
    now: () => "2026-07-17T10:06:00.000Z",
    activeWindow: "1d",
  });

  // The Operator delegates; the executor records the run and the launcher reports the child's
  // ACP session identity. That identity is what the child's transcript will surface under.
  const run = state.createAgentRun({
    harness: AgentRunHarness.ClaudeCode,
    task: "research the flaky test",
    cwd: dir,
    parentThreadId: "operator-thread",
    depth: 1,
    timeoutSeconds: 3_600,
  });
  const running = state.claimNextPendingAgentRun(3)!;
  state.recordAgentRunActivity(running.id, { childSessionId: "claude-child-abc" });

  // The monitor observes the child's transcript through its ordinary scan path — the same
  // entry point (recordObservation) it uses for every coding session.
  state.recordObservation(scanRow("claude-child-abc"));
  state.recordObservation(scanRow("unrelated-session"));

  const rows = state.listCurrentSessionState();
  const child = rows.find((row) => row.id === "claude-child-abc");
  const unrelated = rows.find((row) => row.id === "unrelated-session");
  assert.ok(child, "the delegated child is observed as a thread, not hidden");
  assert.equal(child?.parentThreadId, "operator-thread", "the child nests under its delegating parent by identity");
  assert.equal(unrelated?.parentThreadId, null, "an ordinary coding session has no parent");
  assert.equal(run.parentThreadId, "operator-thread");

  process.stdout.write("ok — delegated child transcript nests under its parent through the monitor path\n");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
