// Integration: a run started by an outside caller (`--origin`) is a root session-state row that
// names its caller, from launch until it finishes, while an ordinary delegation still nests under
// its parent and a parent that matches no session leaves its child at the root.
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRunHarness, AgentRunStatus, type ScanRow } from "@owner-operator/core";
import { InMemoryEventBus } from "./event-bus";
import { State } from "./state";

const dir = mkdtempSync(join(tmpdir(), "oo-delegated-origin-"));
const previousOoHome = process.env.OO_HOME;
process.env.OO_HOME = dir;

const scanRow = (id: string, topic: string, working = true): ScanRow => ({
  id,
  source: "claude",
  repo: "owner-operator",
  project: dir,
  app: "Claude CLI",
  topic,
  lastRole: "assistant",
  createdAt: "2026-07-17T10:00:00.000Z",
  lastMessageAt: "2026-07-17T10:05:00.000Z",
  secondsSinceLastMessage: 30,
  secondsSinceActivity: 30,
  working,
});

let closeState: (() => void) | undefined;
try {
  const state = new State(join(dir, "state.db"), {
    bus: new InMemoryEventBus(),
    now: () => "2026-07-17T10:06:00.000Z",
    activeWindow: "1d",
  });
  closeState = () => state.close();
  state.recordObservation({ ...scanRow("operator-thread", "Coordinate the release", false), app: "Owner Operator" });
  const rowById = (id: string) => state.listCurrentSessionState().find((row) => row.id === id);

  const remote = state.createAgentRun({
    harness: AgentRunHarness.ClaudeCode,
    task: "Fix the login bug reported in chat",
    cwd: dir,
    parentThreadId: "operator-thread",
    depth: 1,
    timeoutSeconds: 3_600,
    origin: "grok-bot",
  });
  const queued = rowById(remote.id);
  assert.ok(queued, "a queued origin run shows before any transcript exists");
  assert.equal(queued.origin, "grok-bot", "the row names who started the run");
  assert.equal(queued.topic, "Fix the login bug reported in chat");
  assert.equal(queued.section, "working");
  assert.equal(queued.depth, 0, "an origin run is a root even when its run names a visible parent");
  assert.equal(queued.parentThreadId, null);
  assert.equal(queued.awaitingTranscript, true, "a ledger row has no thread to act on yet");
  assert.equal(queued.app, "Claude CLI", "a ledger row shows its run harness, not its origin");

  state.claimNextPendingAgentRun(3);
  state.recordAgentRunActivity(remote.id, { childSessionId: "grok-child" });
  assert.equal(rowById(remote.id), undefined, "the ledger row moves to the child's session identity");
  assert.equal(rowById("grok-child")?.origin, "grok-bot", "a running origin run shows before its transcript is indexed");

  state.recordObservation(scanRow("grok-child", "login bug", false));
  const indexed = state.listCurrentSessionState().filter((row) => row.id === "grok-child");
  assert.equal(indexed.length, 1, "the indexed thread replaces the ledger row");
  assert.equal(indexed[0].origin, "grok-bot", "the indexed thread keeps its origin");
  assert.equal(indexed[0].depth, 0, "the indexed origin thread stays a root");
  assert.equal(indexed[0].topic, "login bug", "the indexed thread supplies the row's facts");
  assert.equal(indexed[0].app, queued.app, "the indexed thread keeps the ledger row's harness badge");
  assert.equal(indexed[0].awaitingTranscript, false);
  assert.equal(indexed[0].section, "working", "a running origin run stays working between transcript turns");
  state.finishAgentRun(remote.id, { status: AgentRunStatus.Completed, resultTail: "fixed", error: null });
  assert.notEqual(rowById("grok-child")?.section, "working", "a finished origin run takes its transcript state");

  const local = state.createAgentRun({
    harness: AgentRunHarness.Codex,
    task: "local follow-up",
    cwd: dir,
    parentThreadId: "operator-thread",
    depth: 1,
    timeoutSeconds: 3_600,
  });
  assert.equal(rowById(local.id), undefined, "a run without an origin waits for its transcript");
  state.claimNextPendingAgentRun(3);
  state.recordAgentRunActivity(local.id, { childSessionId: "local-child" });
  state.recordObservation(scanRow("local-child", "local follow-up work"));
  const nested = rowById("local-child");
  assert.equal(nested?.origin, null);
  assert.equal(nested?.parentThreadId, "operator-thread");
  assert.equal(nested?.depth, 1, "a run without an origin nests under its parent");

  const orphan = state.createAgentRun({
    harness: AgentRunHarness.Codex,
    task: "orphaned child",
    cwd: dir,
    parentThreadId: "no-such-session",
    depth: 1,
    timeoutSeconds: 3_600,
  });
  state.claimNextPendingAgentRun(3);
  state.recordAgentRunActivity(orphan.id, { childSessionId: "orphan-child" });
  state.recordObservation(scanRow("orphan-child", "orphaned child work", false));
  const unparented = rowById("orphan-child");
  assert.equal(unparented?.parentThreadId, "no-such-session", "the run's parent link is still reported");
  assert.equal(unparented?.depth, 0, "a parent that matches no session leaves the child at the root");
  assert.equal(unparented?.section, "idle", "an unparented child takes its own section");

  state.recordObservation({
    ...scanRow("stale-origin-child", "old remote work", false),
    lastMessageAt: "2026-07-01T10:00:00.000Z",
    secondsSinceLastMessage: 1_382_400,
    secondsSinceActivity: 1_382_400,
  });
  assert.equal(rowById("stale-origin-child"), undefined, "a quiet session outside the window is hidden");
  state.createAgentRun({
    harness: AgentRunHarness.Codex,
    task: "resume the old remote work",
    cwd: dir,
    depth: 0,
    timeoutSeconds: 3_600,
    origin: "grok-bot",
    childSessionId: "stale-origin-child",
  });
  const resumed = rowById("stale-origin-child");
  assert.equal(resumed?.section, "working", "resuming an origin session outside the window shows it at once");
  assert.equal(resumed?.awaitingTranscript, false, "the indexed thread backs the resumed row");

  const cancelled = state.createAgentRun({
    harness: AgentRunHarness.Codex,
    task: "never indexed",
    cwd: dir,
    depth: 0,
    timeoutSeconds: 3_600,
    origin: "grok-bot",
  });
  assert.equal(rowById(cancelled.id)?.app, "Codex CLI", "a pending origin run is visible under its harness");
  state.claimNextPendingAgentRun(3);
  state.finishAgentRun(cancelled.id, { status: AgentRunStatus.Cancelled, resultTail: null, error: null });
  assert.equal(rowById(cancelled.id), undefined, "a finished origin run with no transcript leaves the view");

  const hosted = state.createAgentRun({
    harness: AgentRunHarness.OpenCode,
    task: "work in a Conductor workspace",
    cwd: join(homedir(), "conductor", "workspaces", "owner-operator", "lisbon"),
    depth: 0,
    timeoutSeconds: 3_600,
    origin: "grok-bot",
  });
  assert.equal(rowById(hosted.id)?.app, "OpenCode", "a pending origin run shows its harness, not its workspace host");
} finally {
  closeState?.();
  if (previousOoHome === undefined) delete process.env.OO_HOME;
  else process.env.OO_HOME = previousOoHome;
  rmSync(dir, { recursive: true, force: true });
}

process.stdout.write("ok — delegated run origin projects a root row\n");
