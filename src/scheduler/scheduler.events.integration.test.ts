import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentRunHarness,
  AgentRunStatus,
  ScheduleKind,
  ScheduledPayloadKind,
  type ScanRow,
  type ScheduleExecutionResult,
  type ScheduledPromptRunRequest,
} from "@owner-operator/core";
import { waitFor } from "../gateway/test/helpers";
import { State } from "../state/state";
import { Scheduler } from "./scheduler";

const dir = mkdtempSync(join(tmpdir(), "oo-scheduler-events-"));
const state = new State(join(dir, "state.db"));
const contexts: unknown[] = [];
const scheduler = new Scheduler(state, {
  tickMs: 60_000,
  promptRunner: async (request: ScheduledPromptRunRequest): Promise<ScheduleExecutionResult> => {
    contexts.push(request.triggerContext);
    return { exitCode: 0, stdout: "handled", stderr: "", transcriptId: `transcript-${contexts.length}` };
  },
});

const row = (id: string, lastMessageAt: string): ScanRow => ({
  id, source: "codex", repo: "demo", app: "Codex", topic: id,
  lastRole: "assistant", working: false,
  createdAt: "2026-07-09T09:00:00.000Z", lastMessageAt,
  secondsSinceLastMessage: 10, secondsSinceActivity: 10,
});

try {
  const job = scheduler.createSchedule({
    name: "needs-you brief",
    enabled: true,
    trigger: { kind: ScheduleKind.NeedsYou },
    payload: { kind: ScheduledPayloadKind.Prompt, prompt: "Brief me" },
    cwd: dir,
    timeoutSeconds: 1_800,
  });
  scheduler.start();

  const owed = (statusSummary: string) => ({ topic: "Retention decision", statusSummary, attention: "needs-you" as const });

  // A scan alone never says the owner owes anything, so nothing fires until the classifier
  // finds the session needs its owner. Both findings land in one tick and batch into one run.
  state.recordPoll([
    row("a", "2026-07-09T10:00:00.000Z"),
    row("b", "2026-07-09T10:01:00.000Z"),
  ]);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(contexts.length, 0, "a yielded turn is not an owner action");
  assert.ok(state.appendEnrichment("a", owed("Choose the retention period."), "2026-07-09T10:00:00.000Z"));
  assert.ok(state.appendEnrichment("b", owed("Choose the retention period."), "2026-07-09T10:01:00.000Z"));
  await waitFor(() => contexts.length === 1, 1_000, "batched needs-you run");
  assert.deepEqual(contexts[0], {
    threadIds: ["a", "b"],
    observedThrough: "2026-07-09T10:01:00.000Z",
  });

  state.recordPoll([
    row("a", "2026-07-09T10:00:00.000Z"),
    row("b", "2026-07-09T10:01:00.000Z"),
  ]);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(contexts.length, 1, "persisted watermarks suppress duplicate messages");

  state.recordObservation(row("a", "2026-07-09T10:02:00.000Z"));
  assert.ok(state.appendEnrichment("a", owed("Still waiting on the retention period."), "2026-07-09T10:02:00.000Z"));
  await waitFor(() => contexts.length === 2, 1_000, "same-state new-message run");
  assert.equal(state.listScheduleRuns(job.id).length, 2);

  state.recordObservation(row("delegating-root", "2026-07-09T10:03:00.000Z"));
  assert.ok(state.appendEnrichment("delegating-root", owed("Choose the retention period."), "2026-07-09T10:03:00.000Z"));
  const child = state.createAgentRun({
    harness: AgentRunHarness.Codex,
    task: "handle the root task",
    cwd: dir,
    parentThreadId: "delegating-root",
    depth: 1,
    timeoutSeconds: 1_800,
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(contexts.length, 2, "a pending child suppresses an already-queued needs-you trigger");

  state.claimNextPendingAgentRun(1);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(contexts.length, 2, "a running child keeps the root out of needs-you triggers");

  state.finishAgentRun(child.id, {
    status: AgentRunStatus.Completed,
    resultTail: "handled",
    error: null,
  });
  await waitFor(() => contexts.length === 3, 1_000, "terminal child to restore needs-you trigger");
  assert.deepEqual(contexts[2], {
    threadIds: ["delegating-root"],
    observedThrough: "2026-07-09T10:03:00.000Z",
  });

  const idle = { ...row("model-attention", "2026-07-09T10:04:00.000Z"), lastRole: "user", secondsSinceLastMessage: 7200, secondsSinceActivity: 7200 };
  state.recordObservation(idle);
  assert.equal(state.listSessionState().find((item) => item.id === idle.id)?.state, "idle");
  const noAction = { topic: "CSV escaping review", statusSummary: "The agent reports completion but CSV verification evidence is missing.", attention: "idle" as const };
  assert.ok(state.appendEnrichment(idle.id, noAction, idle.lastMessageAt));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(contexts.length, 3, "an Idle verdict cannot trigger a schedule");
  assert.equal(state.listScheduleRuns(job.id).length, 3);
  idle.lastMessageAt = "2026-07-09T10:05:00.000Z";
  state.recordObservation(idle);
  const details = { topic: "Retention decision", statusSummary: "Choose the retention period.", attention: "needs-you" as const };
  assert.ok(state.appendEnrichment(idle.id, details, idle.lastMessageAt));
  await waitFor(() => contexts.length === 4, 1_000, "model attention triggers needs-you schedule");
  state.renameThread(idle.id, "Pinned decision");
  state.requestEnrichment([{ id: idle.id, lastMessageAt: idle.lastMessageAt }]);
  assert.ok(state.appendEnrichment(idle.id, details, idle.lastMessageAt));
  state.recordObservation(idle);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(contexts.length, 4, "rename, resummary, and scan do not duplicate a handled message");

  state.recordObservation(row("snoozed-decision", "2026-07-09T10:06:00.000Z"));
  assert.equal(state.snoozeThread("snoozed-decision", { kind: "next-message" }), "applied");
  assert.ok(state.appendEnrichment("snoozed-decision", owed("Choose the retention period."), "2026-07-09T10:06:00.000Z"));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(contexts.length, 4, "a snoozed needs-you row never triggers a schedule");
  assert.equal(state.snoozeThread("snoozed-decision", null), "applied");
  await waitFor(() => contexts.length === 5, 1_000, "waking a snoozed needs-you row triggers the schedule");
  assert.deepEqual(contexts[4], {
    threadIds: ["snoozed-decision"],
    observedThrough: "2026-07-09T10:06:00.000Z",
  });

  state.recordObservation(row("timed-snooze", "2026-07-09T10:07:00.000Z"));
  assert.equal(state.snoozeThread("timed-snooze", { kind: "until", until: new Date(Date.now() + 100).toISOString() }), "applied");
  assert.ok(state.appendEnrichment("timed-snooze", owed("Choose the retention period."), "2026-07-09T10:07:00.000Z"));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(contexts.length, 5, "a held timed snooze never triggers a schedule");
  await new Promise((resolve) => setTimeout(resolve, 100));
  await scheduler.tick();
  await waitFor(() => contexts.length === 6, 1_000, "a timed snooze that ends without a new message triggers on the next tick");
  assert.deepEqual(contexts[5], { threadIds: ["timed-snooze"], observedThrough: "2026-07-09T10:07:00.000Z" });
  await scheduler.tick();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(contexts.length, 6, "later ticks do not rerun a handled row");
  process.stdout.write("ok — needs-you event batching, model attention, dedupe, and active-child and snooze suppression\n");
} finally {
  await scheduler.stop();
  state.close();
  rmSync(dir, { recursive: true, force: true });
}
