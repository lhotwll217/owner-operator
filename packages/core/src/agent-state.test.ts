import assert from "node:assert";
import {
  AgentRunHarness,
  AgentRunStatus,
  type AgentRun,
} from "./agent-runs";
import {
  AGENT_STATE_ACTIVITY_MAX_LENGTH,
  AGENT_STATE_RECENT_LIMIT,
  AGENT_STATE_TASK_MAX_LENGTH,
  agentRunCompletionEventId,
  createAgentRunCompletionEnvelope,
  deriveParentAgentState,
} from "./agent-state";
import { agentRunFixture as run } from "../../../test/fixtures/agent-run";

const now = "2026-07-21T12:10:00.000Z";
const fleet = [
  run("completed-new", AgentRunStatus.Completed, {
    task: "x".repeat(AGENT_STATE_TASK_MAX_LENGTH + 20),
    resultTail: "done",
    finishedAt: "2026-07-21T12:09:00.000Z",
  }),
  run("running", AgentRunStatus.Running, {
    harness: AgentRunHarness.Codex,
    activity: `Reading ${"nested/".repeat(30)}file.ts`,
    lastActivityAt: "2026-07-21T12:09:30.000Z",
    childSessionId: "codex-child",
  }),
  run("queued", AgentRunStatus.Pending),
  run("failed", AgentRunStatus.Failed, {
    error: "ACP startup failed",
    childSessionId: "failed-child",
    finishedAt: "2026-07-21T12:08:00.000Z",
  }),
  run("lost-no-child", AgentRunStatus.Lost, {
    error: "daemon could not find a live turn",
    finishedAt: "2026-07-21T12:07:00.000Z",
  }),
  run("cancelled", AgentRunStatus.Cancelled, {
    finishedAt: "2026-07-21T12:06:00.000Z",
  }),
];

const view = deriveParentAgentState(fleet, { now, recentLimit: AGENT_STATE_RECENT_LIMIT });
assert.deepEqual(view.counts, { queued: 1, running: 1, attention: 2 });
assert.equal(view.footer, "Agent state: 1 queued · 1 running · 2 need attention");
assert.deepEqual(
  view.runs.map(({ id }) => id),
  ["failed", "lost-no-child", "running", "queued", "completed-new", "cancelled"],
  "picker order is attention, active, then recent terminal; each group is newest first",
);

const running = view.runs.find(({ id }) => id === "running")!;
assert.deepEqual(
  {
    glyph: running.status.glyph,
    text: running.status.text,
    category: running.category,
    canCancel: running.canCancel,
    canResume: running.canResume,
    elapsedMs: running.elapsedMs,
  },
  { glyph: "●", text: "running", category: "active", canCancel: true, canResume: false, elapsedMs: 540_000 },
);
assert.ok(running.latestActivity.length <= AGENT_STATE_ACTIVITY_MAX_LENGTH);
assert.ok(!running.latestActivity.includes("/tmp/repo"), "detail does not invent or expose cwd");

const queued = view.runs.find(({ id }) => id === "queued")!;
assert.deepEqual([queued.status.glyph, queued.status.text, queued.canCancel], ["◦", "queued", true]);
assert.equal(view.runs.find(({ id }) => id === "failed")?.canResume, true, "failed child identity is resumable");
assert.equal(view.runs.find(({ id }) => id === "lost-no-child")?.canResume, false, "missing child identity blocks resume");
assert.ok(view.runs.find(({ id }) => id === "completed-new")!.task.length <= AGENT_STATE_TASK_MAX_LENGTH);
assert.equal(
  view.runs.find(({ id }) => id === "completed-new")!.latestActivity,
  "",
  "terminal result evidence is not relabeled as latest activity",
);

const idle = deriveParentAgentState([
  run("done", AgentRunStatus.Completed),
  run("owner-cancelled", AgentRunStatus.Cancelled),
], { now });
assert.equal(idle.footer, null, "footer hides when no run is active or awaiting attention");

const resumedFailure = deriveParentAgentState([
  run("failed-predecessor", AgentRunStatus.Failed, { childSessionId: "resumed-child" }),
  run("resume", AgentRunStatus.Running, {
    childSessionId: "resumed-child",
    resumeOfRunId: "failed-predecessor",
  }),
], { now });
assert.equal(
  resumedFailure.runs.find(({ id }) => id === "failed-predecessor")?.category,
  "recent",
  "a resumed predecessor becomes terminal history instead of demanding attention",
);
assert.equal(resumedFailure.counts.attention, 0);

const resumedOnlyFailure = deriveParentAgentState([
  run("only-failure", AgentRunStatus.Failed, { childSessionId: "resumed-child" }),
  run("successful-resume", AgentRunStatus.Completed, {
    childSessionId: "resumed-child",
    resumeOfRunId: "only-failure",
  }),
], { now });
assert.equal(resumedOnlyFailure.footer, null, "footer hides when the only failure has been resumed");

const unresumedFailure = deriveParentAgentState([
  run("unresumed-failure", AgentRunStatus.Failed, { childSessionId: "failed-child" }),
], { now });
assert.equal(unresumedFailure.counts.attention, 1, "an unresumed failure still demands attention");
assert.equal(unresumedFailure.runs[0]?.category, "attention");

const unknownHarness = deriveParentAgentState([
  run("unknown-harness", AgentRunStatus.Failed, {
    harness: "future-harness" as AgentRun["harness"],
    childSessionId: "future-child",
  }),
], { now });
assert.equal(unknownHarness.runs[0]?.canResume, false, "unknown harness capabilities fail closed");

const lotsOfRecent = Array.from({ length: AGENT_STATE_RECENT_LIMIT + 4 }, (_, index) =>
  run(`recent-${index}`, AgentRunStatus.Completed, {
    finishedAt: new Date(Date.parse(now) - index * 1_000).toISOString(),
  }));
assert.equal(
  deriveParentAgentState(lotsOfRecent, { now }).runs.length,
  AGENT_STATE_RECENT_LIMIT,
  "routine terminal history is bounded",
);

const terminal = run("completed-new", AgentRunStatus.Completed, {
  task: "Summarize authentication findings",
  childSessionId: "child-123",
  resultTail: "z".repeat(2_000),
  finishedAt: "2026-07-21T12:09:00.000Z",
});
const envelope = createAgentRunCompletionEnvelope(terminal, {
  artifacts: [{ label: "report", reference: "artifact://auth-report" }],
});
assert.equal(envelope.version, 1);
assert.equal(envelope.eventId, agentRunCompletionEventId(terminal.id));
assert.equal(envelope.evidence.trust, "untrusted");
assert.ok(envelope.evidence.result.length < terminal.resultTail!.length, "child result is bounded");
assert.deepEqual(envelope.artifacts, [{ label: "report", reference: "artifact://auth-report" }]);
assert.match(envelope.parentInstruction, /material outcome.*implication.*owner action/i);
assert.throws(
  () => createAgentRunCompletionEnvelope(run("not-done", AgentRunStatus.Running)),
  /terminal run/,
);

process.stdout.write("ok — browser-safe agent run views and completion envelopes\n");
